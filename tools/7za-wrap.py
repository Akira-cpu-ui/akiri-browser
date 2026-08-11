# 7za wrapper: app-builder passes "-snld" (create symlinks), which fails on
# Windows without admin privileges. Without the flag 7-Zip still extracts the
# symlink entries as regular files; only the link creation errors out with
# exit code 2. We treat that specific case as success.
import subprocess
import sys

REAL = r"C:\FreebuffBrowser\node_modules\7zip-bin\win\x64\7za.exe"

args = [a for a in sys.argv[1:] if a != "-snld"]
p = subprocess.run([REAL] + args, capture_output=True)

sys.stdout.buffer.write(p.stdout)
sys.stderr.buffer.write(p.stderr)
sys.stdout.buffer.flush()
sys.stderr.buffer.flush()

rc = p.returncode
if rc == 2:
    err = (p.stderr or b"").lower()
    # exit 2 caused only by failing to create symbolic links -> still OK
    if b"symbolic link" in err and b"cannot create" in err:
        rc = 0
sys.exit(rc)
