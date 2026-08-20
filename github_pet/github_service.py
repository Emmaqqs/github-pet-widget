"""GitHub REST client and deterministic PR alert classifier."""
from datetime import datetime, timezone
import json
import os
from typing import Any, Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .models import (
    MY_PR_ACTIVITY, RE_REVIEW_NEEDED, REVIEW_REQUIRED,
    Alert, MonitorSnapshot, PullRequest,
)

Json = dict[str, Any]


def parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class GitHubError(RuntimeError):
    pass


class GitHubClient:
    def __init__(self, token: Optional[str] = None, api_base: str = "https://api.github.com",
                 opener: Callable[..., Any] = urlopen):
        self.token = token or os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
        self.api_base = api_base.rstrip("/")
        self.opener = opener

    def get(self, path: str, params: Optional[dict[str, str]] = None) -> Any:
        query = ""
        if params:
            query = "?" + "&".join(f"{quote(k)}={quote(v)}" for k, v in params.items())
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(self.api_base + path + query, headers=headers)
        try:
            with self.opener(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError) as exc:
            raise GitHubError(f"GitHub API request failed: {exc}") from exc

    def authenticated_user(self) -> Json:
        return self.get("/user")

    def assigned_prs(self, username: str) -> list[Json]:
        return self.get("/search/issues", {"q": f"is:pr is:open review-requested:{username}", "per_page": "100"})["items"]

    def authored_prs(self, username: str) -> list[Json]:
        return self.get("/search/issues", {"q": f"is:pr is:open author:{username}", "per_page": "100"})["items"]

    def pr_details(self, owner: str, repo: str, number: int) -> Json:
        return self.get(f"/repos/{quote(owner)}/{quote(repo)}/pulls/{number}")

    def reviews(self, owner: str, repo: str, number: int) -> list[Json]:
        return self.get(f"/repos/{quote(owner)}/{quote(repo)}/pulls/{number}/reviews", {"per_page": "100"})

    def issue_comments(self, owner: str, repo: str, number: int) -> list[Json]:
        return self.get(f"/repos/{quote(owner)}/{quote(repo)}/issues/{number}/comments", {"per_page": "100"})

    def review_comments(self, owner: str, repo: str, number: int) -> list[Json]:
        return self.get(f"/repos/{quote(owner)}/{quote(repo)}/pulls/{number}/comments", {"per_page": "100"})

    def to_pr(self, item: Json, username: str, details: Optional[Json] = None,
              reviews: Optional[list[Json]] = None, issue_comments: Optional[list[Json]] = None,
              review_comments: Optional[list[Json]] = None, previous_head_sha: Optional[str] = None,
              last_seen_at: Optional[datetime] = None) -> PullRequest:
        d = details or item
        repo_value = d.get("base", {}).get("repo", {}).get("full_name")
        if repo_value:
            owner, repo = repo_value.split("/", 1)
        else:
            parts = item.get("repository_url", "").rstrip("/").split("/")
            owner, repo = (parts[-2], parts[-1]) if len(parts) >= 2 else ("", "")
        all_reviews = reviews or []
        mine = [r for r in all_reviews if r.get("user", {}).get("login", "").lower() == username.lower()]
        latest = max((parse_dt(r.get("submitted_at")) for r in mine if r.get("submitted_at")), default=None)
        latest_mine = max(mine, key=lambda r: parse_dt(r.get("submitted_at")) or datetime.min) if mine else None
        state = latest_mine.get("state") if latest_mine else None
        approvals = sum(r.get("state") == "APPROVED" for r in all_reviews)
        others = [r for r in all_reviews if r.get("user", {}).get("login", "").lower() != username.lower()]
        other_approvals = sum(r.get("state") == "APPROVED" for r in others)
        other_requested_changes = sum(r.get("state") == "CHANGES_REQUESTED" for r in others)
        issue_comments = issue_comments or []
        review_comments = review_comments or []
        activity_times = [parse_dt(x.get("created_at")) for x in issue_comments + review_comments]
        activity_times += [parse_dt(x.get("submitted_at")) for x in all_reviews]
        latest_activity = max((x for x in activity_times if x), default=None)
        def is_new(value: Optional[str]) -> bool:
            timestamp = parse_dt(value)
            return bool(timestamp and (last_seen_at is None or timestamp > last_seen_at))
        new_issue_comments = sum(is_new(x.get("created_at")) for x in issue_comments)
        new_review_comments = sum(is_new(x.get("created_at")) for x in review_comments)
        new_commits = bool(previous_head_sha and d.get("head", {}).get("sha") != previous_head_sha)
        activity_is_new = None if last_seen_at is None else bool(latest_activity and latest_activity > last_seen_at)
        return PullRequest(
            number=int(d["number"]), title=d["title"], url=d["html_url"], owner=owner, repo=repo,
            author=d.get("user", {}).get("login", ""), updated_at=parse_dt(d.get("updated_at")) or datetime.now(timezone.utc),
            head_sha=d.get("head", {}).get("sha", ""), reviewers=tuple(x.get("login", "") for x in d.get("requested_reviewers", [])),
            my_review_state=state, latest_review_at=latest, comments_count=int(d.get("comments", 0)),
            review_comments_count=int(d.get("review_comments", 0)), requested_changes=other_requested_changes > 0, approvals=approvals,
            other_approvals=other_approvals, other_requested_changes=other_requested_changes,
            new_issue_comments=new_issue_comments, new_review_comments=new_review_comments,
            new_commits=new_commits, activity_is_new=activity_is_new, latest_activity_at=latest_activity)


def classify_prs(prs: list[PullRequest], username: str, now: Optional[datetime] = None) -> MonitorSnapshot:
    """Classify PRs. Priority: own-PR activity, re-review, review assignment."""
    alerts: list[Alert] = []
    for pr in prs:
        if pr.author.lower() == username.lower():
            collaborator_activity = pr.other_approvals or pr.other_requested_changes or pr.new_issue_comments or pr.new_review_comments
            legacy_activity = pr.activity_is_new is None and (pr.approvals or pr.comments_count or pr.review_comments_count)
            if pr.activity_is_new is not False and (pr.requested_changes or collaborator_activity or legacy_activity):
                if pr.other_requested_changes or pr.requested_changes:
                    detail = "Cambios pedidos ⚠️"
                elif pr.other_approvals or pr.approvals:
                    detail = "Aprobación de un colaborador ✅"
                else:
                    detail = "Comentario nuevo 💬"
                alerts.append(Alert(MY_PR_ACTIVITY, "Actividad en tu PR", pr, f"⚡ Actividad en tus PRs: {pr.title} ({detail})"))
        elif username.lower() in {r.lower() for r in pr.reviewers} and not pr.my_review_state:
            alerts.append(Alert(REVIEW_REQUIRED, "Review pendiente", pr, f"⏳ Revisión Requerida: {pr.title} (Asignado)"))
        elif pr.latest_review_at and pr.updated_at > pr.latest_review_at:
            if pr.new_commits or pr.new_issue_comments or pr.new_review_comments or pr.activity_is_new is True:
                alerts.append(Alert(RE_REVIEW_NEEDED, "Re-revisión", pr, f"🔄 Re-revisión Pendiente: {pr.title} (Commits o respuesta de @{pr.author} 💬)"))
    return MonitorSnapshot(tuple(alerts), now or datetime.now(timezone.utc))
