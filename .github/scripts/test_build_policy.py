import unittest
import os
import tempfile
from unittest.mock import patch

from build_policy import main, needs_build


class BuildPolicyTests(unittest.TestCase):
    def test_docs(self):
        self.assertFalse(needs_build("push", ["README.md", "docs/versioning.md"], [], "abc"))

    def test_workflows(self):
        self.assertFalse(needs_build("push", [".github/workflows/build-test.yml", ".github/scripts/build_policy.py"], [], "abc"))

    def test_application_and_documentation(self):
        self.assertTrue(needs_build("push", ["README.md", "src-tauri/src/main.rs"], [], "abc"))

    def test_packaging_inputs(self):
        for path in ("installer.iss", "icon.ico", "scripts/versioning.mjs", "version.txt", "LICENSE", "CHANGELOG.md", "requirements-build.txt"):
            with self.subTest(path=path):
                self.assertTrue(needs_build("push", [path], [], "abc"))

    def test_release_tag(self):
        for tag in ("refs/tags/v1.0.0", "refs/tags/v1.0.0-beta.1", "refs/tags/v1.0.0^{}"):
            with self.subTest(tag=tag):
                self.assertFalse(needs_build("push", ["main.pyw"], [("abc", tag)], "abc"))

    def test_other_tag_or_commit(self):
        self.assertTrue(needs_build("push", ["main.pyw"], [("old", "refs/tags/v1.0.0"), ("abc", "refs/tags/checkpoint")], "abc"))

    def test_manual_override(self):
        self.assertTrue(needs_build("workflow_dispatch", [], [("abc", "refs/tags/v1.0.0")], "abc"))

    def test_push_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, "output")
            with patch.dict(os.environ, GITHUB_EVENT_NAME="push", GITHUB_SHA="abc", BEFORE_SHA="previous", GITHUB_OUTPUT=output):
                with patch("build_policy.git", side_effect=["main.pyw\n", "abc\trefs/tags/v1.0.0-beta.1\n"]) as command:
                    main()
                    self.assertEqual(command.call_args_list[0].args, ("diff", "--name-only", "previous", "abc"))
            with open(output, encoding="utf-8") as result:
                self.assertEqual(result.read(), "build=false\n")

    def test_new_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, "output")
            with patch.dict(os.environ, GITHUB_EVENT_NAME="push", GITHUB_SHA="abc", BEFORE_SHA="0" * 40, GITHUB_OUTPUT=output):
                with patch("build_policy.git", side_effect=["main.pyw\n", ""]) as command:
                    main()
                    self.assertEqual(command.call_args_list[0].args, ("ls-tree", "-r", "--name-only", "abc"))
            with open(output, encoding="utf-8") as result:
                self.assertEqual(result.read(), "build=true\n")


if __name__ == "__main__":
    unittest.main()
