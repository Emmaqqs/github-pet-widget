import json
import unittest
from datetime import datetime, timezone, timedelta

from github_pet.github_service import GitHubClient, classify_prs
from github_pet.models import (
    ALL_CAUGHT_UP, MY_PR_ACTIVITY, RE_REVIEW_NEEDED, REVIEW_REQUIRED, PullRequest,
)


NOW = datetime(2026, 1, 2, tzinfo=timezone.utc)


def pr(author="other", reviewers=(), review=None, updated=None, comments=0, changes=False,
       approvals=0, **kwargs):
    review_at = NOW - timedelta(hours=2) if review else None
    return PullRequest(1, "Test PR", "https://github.com/acme/app/pull/1", "acme", "app", author,
                       updated or NOW, "sha", tuple(reviewers), review, review_at, comments, 0,
                       changes, approvals, **kwargs)


class ClassifierTests(unittest.TestCase):
    def test_review_required_has_exact_state_and_message(self):
        alert = classify_prs([pr(reviewers=("me",))], "me").alerts[0]
        self.assertEqual(alert.kind, REVIEW_REQUIRED)
        self.assertIn("⏳ Revisión Requerida: Test PR (Asignado)", alert.detail)

    def test_assignment_is_not_pending_after_my_review(self):
        self.assertEqual(classify_prs([pr(reviewers=("me",), review="COMMENTED", updated=NOW - timedelta(hours=2))], "me").state, ALL_CAUGHT_UP)

    def test_re_review_for_new_commits(self):
        result = classify_prs([pr(review="APPROVED", new_commits=True)], "me")
        self.assertEqual(result.alerts[0].kind, RE_REVIEW_NEEDED)
        self.assertIn("Commits", result.alerts[0].detail)

    def test_re_review_for_new_issue_comment(self):
        result = classify_prs([pr(review="COMMENTED", new_issue_comments=1)], "me")
        self.assertEqual(result.alerts[0].kind, RE_REVIEW_NEEDED)

    def test_old_activity_can_be_suppressed(self):
        old = pr(review="COMMENTED", updated=NOW, activity_is_new=False)
        self.assertEqual(classify_prs([old], "me").state, ALL_CAUGHT_UP)

    def test_own_pr_approval_from_other_reviewer(self):
        result = classify_prs([pr(author="me", other_approvals=1, activity_is_new=True)], "me")
        self.assertEqual(result.alerts[0].kind, MY_PR_ACTIVITY)
        self.assertIn("Aprobación", result.alerts[0].detail)

    def test_own_pr_changes_requested_by_other_reviewer(self):
        result = classify_prs([pr(author="me", other_requested_changes=1, activity_is_new=True)], "me")
        self.assertEqual(result.alerts[0].kind, MY_PR_ACTIVITY)
        self.assertIn("Cambios pedidos", result.alerts[0].detail)

    def test_own_pr_new_inline_comment(self):
        result = classify_prs([pr(author="me", new_review_comments=1, activity_is_new=True)], "me")
        self.assertEqual(result.alerts[0].kind, MY_PR_ACTIVITY)
        self.assertIn("Comentario nuevo", result.alerts[0].detail)

    def test_own_pr_new_issue_comment(self):
        result = classify_prs([pr(author="me", new_issue_comments=1, activity_is_new=True)], "me")
        self.assertEqual(result.alerts[0].kind, MY_PR_ACTIVITY)

    def test_own_pr_old_comment_is_not_activity(self):
        self.assertEqual(classify_prs([pr(author="me", comments=4, activity_is_new=False)], "me").state, ALL_CAUGHT_UP)

    def test_state_priority_is_own_activity_then_re_review_then_assignment(self):
        prs = [pr(reviewers=("me",)), pr(review="COMMENTED", new_commits=True),
               pr(author="me", other_approvals=1, activity_is_new=True)]
        self.assertEqual(classify_prs(prs, "me").state, MY_PR_ACTIVITY)

    def test_happy_state(self):
        self.assertEqual(classify_prs([pr()], "me").state, ALL_CAUGHT_UP)

    def test_api_client_uses_direct_rest_request(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({"login": "me"}).encode()
        seen = {}
        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["auth"] = request.headers.get("Authorization")
            return Response()
        self.assertEqual(GitHubClient("secret", opener=opener).authenticated_user()["login"], "me")
        self.assertEqual(seen["url"], "https://api.github.com/user")
        self.assertEqual(seen["auth"], "Bearer secret")

    def test_to_pr_separates_other_reviews_and_new_comments(self):
        seen = NOW - timedelta(hours=1)
        details = {"number": 7, "title": "Feature", "html_url": "https://github.com/acme/app/pull/7",
                   "base": {"repo": {"full_name": "acme/app"}}, "user": {"login": "me"},
                   "updated_at": "2026-01-02T12:00:00Z", "head": {"sha": "new"},
                   "requested_reviewers": [], "comments": 2, "review_comments": 1}
        reviews = [{"user": {"login": "reviewer"}, "state": "APPROVED", "submitted_at": "2026-01-02T12:00:00Z"},
                   {"user": {"login": "me"}, "state": "COMMENTED", "submitted_at": "2026-01-02T10:00:00Z"}]
        issue = [{"created_at": "2026-01-02T12:30:00Z"}]
        inline = [{"created_at": "2026-01-02T12:15:00Z"}]
        model = GitHubClient().to_pr(details, "me", details, reviews, issue, inline, "old", seen)
        self.assertEqual(model.other_approvals, 1)
        self.assertEqual(model.new_issue_comments, 1)
        self.assertEqual(model.new_review_comments, 1)
        self.assertTrue(model.new_commits)
        self.assertTrue(model.activity_is_new)


if __name__ == "__main__":
    unittest.main()
