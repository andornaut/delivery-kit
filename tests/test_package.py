"""Committed source packaging, reproducibility and release identity."""
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    def test_pinned_archive_is_reproducible_and_excludes_dirty_and_local_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            for name in ['bin', 'examples', 'libexec', 'scripts', 'tests']:
                shutil.copytree(ROOT / name, source / name, ignore=shutil.ignore_patterns('__pycache__'))
            for name in ['README.md', 'VERSION', 'LICENSE']:
                shutil.copyfile(ROOT / name, source / name)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
            git('init', '-q', '-b', 'main')
            git('add', '--', 'bin', 'examples', 'libexec', 'scripts', 'tests', 'README.md', 'VERSION', 'LICENSE')
            env = os.environ | {'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                                'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
            subprocess.run(['git', '-C', str(source), '-c', 'core.hooksPath=/dev/null',
                            'commit', '-q', '--no-verify', '-m', 'Fixture'], env=env, check=True)
            revision = git('rev-parse', 'HEAD')
            original = (source / 'README.md').read_bytes()
            (source / 'README.md').write_text('uncommitted edit')
            (source / 'local-only').write_text('not packaged')
            script = source / 'scripts/package.sh'
            outputs = [root / 'first', root / 'second']
            for index, output in enumerate(outputs):
                subprocess.run(['bash', str(script), revision, str(output)], check=True, capture_output=True,
                               umask=0o077 if index else 0o022)
                subprocess.run(['sha256sum', '--check', 'SHA256SUMS'], cwd=output, check=True, capture_output=True)
                self.assertEqual((output / 'SOURCE_COMMIT').read_text(), revision + '\n')
            archive_name = 'delivery-kit-' + (source / 'VERSION').read_text().strip() + '.tar.gz'
            archives = [output / archive_name for output in outputs]
            self.assertEqual(archives[0].read_bytes(), archives[1].read_bytes())
            with tarfile.open(archives[0]) as archive:
                prefix = archive_name.removesuffix('.tar.gz') + '/'
                names = archive.getnames()
                self.assertEqual(archive.extractfile(prefix + 'README.md').read(), original)
                self.assertEqual(archive.extractfile(prefix + 'SOURCE_COMMIT').read().decode(), revision + '\n')
                self.assertTrue(archive.getmember(prefix + 'bin/delivery-kit').mode & 0o111)
                self.assertIn(prefix + 'LICENSE', names)
                self.assertNotIn(prefix + 'local-only', names)
                self.assertFalse(any('/.git' in name for name in names))
            for revision_arg, destination in [('HEAD', root / 'invalid'), (revision, outputs[0])]:
                result = subprocess.run(['bash', str(script), revision_arg, str(destination)], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
