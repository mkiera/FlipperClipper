import os
import subprocess


def needs_build(event, paths, tags, sha):
    if event == "workflow_dispatch":
        return True
    if any(name.startswith("refs/tags/v") and commit == sha for commit, name in tags):
        return False
    return any(
        path not in ("README.md", ".github/PULL_REQUEST_TEMPLATE.md")
        and not path.startswith(("docs/", ".github/"))
        for path in paths
    )


def git(*args):
    return subprocess.check_output(["git", *args], text=True)


def main():
    event = os.environ["GITHUB_EVENT_NAME"]
    sha = os.environ["GITHUB_SHA"]
    before = os.environ.get("BEFORE_SHA", "")
    if event == "workflow_dispatch":
        build = True
    else:
        if not before or set(before) == {"0"}:
            paths = git("ls-tree", "-r", "--name-only", sha).splitlines()
        else:
            paths = git("diff", "--name-only", before, sha).splitlines()
        tags = [line.split("\t", 1) for line in git("ls-remote", "origin", "refs/tags/v*").splitlines()]
        build = needs_build(event, paths, tags, sha)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"build={str(build).lower()}\n")
    print("App build required." if build else "App build skipped: documentation, workflow changes, or a release tag.")


if __name__ == "__main__":
    main()
