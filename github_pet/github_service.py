"""GitHub REST client and deterministic PR alert classifier.

No LLM calls are made here. Polling, when enabled by the UI, is plain HTTP.
"""
from datetime import datetime, timezone
import json
import os
from typing import Any, Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .models import Alert, MonitorSnapshot, PullRequest

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

    def to_pr(self, item: Json, username: str, details: Optional[Json] = None,
              reviews: Optional[list[Json]] = None) -> PullRequest:
        d = details or item
        repo = d.get("base", {}).get("repo", {}).get("full_name", item.get("repository_url", "").rstrip("/").split("/")[-2:])
        if isinstance(repo, list): owner, repo = repo if len(repo) == 2 else ("", "")
        else: owner, repo = repo.split("/", 1)
        mine = [r for r in (reviews or []) if r.get("user", {}).get("login", "").lower() == username.lower()]
        latest = max((parse_dt(r.get("submitted_at")) for r in mine if r.get("submitted_at")), default=None)
        state = mine[-1].get("state") if mine else None
        approvals = sum(1 for r in (reviews or []) if r.get("state") == "APPROVED")
        return PullRequest(
            number=int(d["number"]), title=d["title"], url=d["html_url"], owner=owner, repo=repo,
            author=d.get("user", {}).get("login", ""), updated_at=parse_dt(d.get("updated_at")) or datetime.now(timezone.utc),
            head_sha=d.get("head", {}).get("sha", ""), reviewers=tuple(x.get("login", "") for x in d.get("requested_reviewers", [])),
            my_review_state=state, latest_review_at=latest, comments_count=int(d.get("comments", 0)),
            review_comments_count=int(d.get("review_comments", 0)), requested_changes=state == "CHANGES_REQUESTED", approvals=approvals)


def classify_prs(prs: list[PullRequest], username: str, now: Optional[datetime] = None) -> MonitorSnapshot:
    """Classify three scenarios. A PR produces at most one alert.

    Scenario B is represented by ``updated_at > latest_review_at`` after a review.
    """
    alerts: list[Alert] = []
    for pr in prs:
        if pr.author.lower() == username.lower():
            if pr.requested_changes:
                alerts.append(Alert("ACTION_REQUIRED", "Cambios solicitados", pr, "Hay cambios solicitados en tu PR."))
            elif pr.approvals or pr.comments_count or pr.review_comments_count:
                alerts.append(Alert("ACTION_REQUIRED", "Actividad en tu PR", pr, "Tu PR tiene aprobaciones o comentarios nuevos."))
        elif username.lower() in {r.lower() for r in pr.reviewers} and not pr.my_review_state:
            alerts.append(Alert("REVIEW_REQUIRED", "Review pendiente", pr, "Te asignaron como reviewer y aún no has revisado."))
        elif pr.latest_review_at and pr.updated_at > pr.latest_review_at:
            alerts.append(Alert("RE_REVIEW", "Re-revisión", pr, "El PR cambió después de tu última review."))
    return MonitorSnapshot(tuple(alerts), now or datetime.now(timezone.utc))

