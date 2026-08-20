from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class PullRequest:
    number: int
    title: str
    url: str
    owner: str
    repo: str
    author: str
    updated_at: datetime
    head_sha: str
    reviewers: tuple[str, ...] = ()
    my_review_state: Optional[str] = None
    latest_review_at: Optional[datetime] = None
    comments_count: int = 0
    review_comments_count: int = 0
    requested_changes: bool = False
    approvals: int = 0


@dataclass(frozen=True)
class Alert:
    kind: str
    label: str
    pr: PullRequest
    detail: str


@dataclass(frozen=True)
class MonitorSnapshot:
    alerts: tuple[Alert, ...]
    checked_at: datetime

    @property
    def state(self) -> str:
        if any(a.kind == "ACTION_REQUIRED" for a in self.alerts):
            return "ACTION_REQUIRED"
        if any(a.kind == "RE_REVIEW" for a in self.alerts):
            return "RE_REVIEW"
        if any(a.kind == "REVIEW_REQUIRED" for a in self.alerts):
            return "ALERT"
        return "HAPPY"

