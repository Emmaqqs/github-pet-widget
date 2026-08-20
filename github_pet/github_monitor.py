from datetime import datetime, timezone
from .github_service import GitHubClient, classify_prs
from .models import MonitorSnapshot


class GitHubMonitor:
    def __init__(self, client: GitHubClient, username: str):
        self.client, self.username = client, username

    def check(self) -> MonitorSnapshot:
        raw = self.client.assigned_prs(self.username) + self.client.authored_prs(self.username)
        seen: set[tuple[str, int]] = set()
        prs = []
        for item in raw:
            repo_url = item.get("repository_url", "")
            parts = repo_url.rstrip("/").split("/")
            if len(parts) < 2:
                continue
            key = (repo_url, int(item["number"]))
            if key in seen:
                continue
            seen.add(key)
            owner, repo = parts[-2:]
            details = self.client.pr_details(owner, repo, int(item["number"]))
            prs.append(self.client.to_pr(item, self.username, details, self.client.reviews(owner, repo, int(item["number"]))))
        return classify_prs(prs, self.username, datetime.now(timezone.utc))

