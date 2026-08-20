import os
import tkinter.messagebox as messagebox
from github_pet.github_monitor import GitHubMonitor
from github_pet.github_service import GitHubClient, GitHubError
from github_pet.widget import PetWidget


def main():
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if not token:
        raise SystemExit("Falta GITHUB_TOKEN (o GH_TOKEN). Configúralo antes de iniciar.")
    client = GitHubClient(token)
    try:
        username = client.authenticated_user()["login"]
    except GitHubError as exc:
        raise SystemExit(str(exc))
    widget = None
    def refresh():
        try: widget.show(GitHubMonitor(client, username).check())
        except GitHubError as exc: messagebox.showerror("GitHub Pet", str(exc))
    widget = PetWidget(refresh)
    refresh()
    widget.run()


if __name__ == "__main__": main()

