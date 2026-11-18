# The static server every view-test runner needs, started so that a run never tests the wrong code.
#
# A runner used to start `python -m http.server <port>` and sleep a second. If another run (another
# worktree, another build session) already held the port, the new server failed to bind and exited
# quietly, and the tests ran against the other run's files. On Windows it is worse: http.server sets
# SO_REUSEADDR, so two servers can both listen on one port and either may answer.
#
# start(port, cwd) refuses a port that something already answers on, then waits until its own server
# answers and is still running. Any failure prints FAIL and exits 1. Find what holds the port
# (netstat -ano | findstr :<port>) instead of picking another port: each session has its own range.
import socket, subprocess, sys, time


def _answers(port):
    for host in ('127.0.0.1', '::1'):
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            pass
    return False


def _fail(msg):
    print('FAIL ' + msg)
    sys.stdout.flush()
    sys.exit(1)


def start(port, cwd, timeout=10.0):
    if _answers(port):
        _fail(f'port {port} is already taken: another test run or server answers on it. '
              f'Find what holds it (netstat -ano | findstr :{port}) instead of picking another port.')
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=cwd,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if srv.poll() is not None:
            _fail(f'the test server on port {port} exited at start (code {srv.returncode})')
        if _answers(port):
            time.sleep(0.3)  # a server that lost the port exits within this; the one answering is then not ours
            if srv.poll() is not None:
                _fail(f'the test server on port {port} exited at start (code {srv.returncode}): something else holds the port')
            return srv
        time.sleep(0.05)
    srv.terminate()
    _fail(f'the test server on port {port} did not answer within {timeout:.0f} s')

