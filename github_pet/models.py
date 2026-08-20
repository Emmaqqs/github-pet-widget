from dataclasses import dataclass
from datetime import datetime
from typing import Optional


REVIEW_REQUIRED = "REVIEW_REQUIRED"
RE_REVIEW_NEEDED = "RE_REVIEW_NEEDED"
MY_PR_ACTIVITY = "MY_PR_ACTIVITY"
ALL_CAUGHT_UP = "ALL_CAUGHT_UP"


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
    other_approvals: int = 0
    other_requested_changes: int = 0
    new_issue_comments: int = 0
    new_review_comments: int = 0
    new_commits: bool = False
    activity_is_new: Optional[bool] = None
    latest_activity_at: Optional[datetime] = None


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
        if any(a.kind == MY_PR_ACTIVITY for a in self.alerts):
            return MY_PR_ACTIVITY
        if any(a.kind == RE_REVIEW_NEEDED for a in self.alerts):
            return RE_REVIEW_NEEDED
        if any(a.kind == REVIEW_REQUIRED for a in self.alerts):
            return REVIEW_REQUIRED
        return ALL_CAUGHT_UP
