import unittest
from datetime import datetime, timezone, timedelta
from github_pet.models import PullRequest
from github_pet.github_service import classify_prs
from github_pet.github_service import GitHubClient
import json

NOW = datetime.now(timezone.utc)
def pr(author="other", reviewers=(), review=None, updated=NOW, comments=0, changes=False, approvals=0):
    return PullRequest(1, "Test PR", "https://github.com/acme/app/pull/1", "acme", "app", author, updated, "sha", tuple(reviewers), review, review and NOW-timedelta(hours=2), comments, 0, changes, approvals)

class ClassifierTests(unittest.TestCase):
    def test_review_required(self): self.assertEqual(classify_prs([pr(reviewers=("me",))], "me").alerts[0].kind, "REVIEW_REQUIRED")
    def test_re_review(self): self.assertEqual(classify_prs([pr(review="APPROVED", updated=NOW)], "me").alerts[0].kind, "RE_REVIEW")
    def test_own_pr_action(self): self.assertEqual(classify_prs([pr(author="me", comments=1)], "me").alerts[0].kind, "ACTION_REQUIRED")
    def test_happy(self): self.assertEqual(classify_prs([pr()], "me").state, "HAPPY")

    def test_api_client_uses_direct_rest_request(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({"login": "me"}).encode()
        seen = {}
        def opener(request, timeout):
            seen["url"] = request.full_url; seen["auth"] = request.headers.get("Authorization"); return Response()
        self.assertEqual(GitHubClient("secret", opener=opener).authenticated_user()["login"], "me")
        self.assertEqual(seen["url"], "https://api.github.com/user")
        self.assertEqual(seen["auth"], "Bearer secret")

if __name__ == "__main__": unittest.main()
