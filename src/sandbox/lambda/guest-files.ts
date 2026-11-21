/**
 * v2 ticket 03 (V2-27, V2-28): the fixed files copied into every MicroVM image, part of the release pin (`guestPinSha256`). They carry no
 * value of any repository. Nothing here runs at build time except the hook agent answering `ready`: `sshd`, `dockerd` and the SSH host key
 * are born in the start script, launched by the `run` hook, so no process and no key comes from the image snapshot.
 *
 * The hook protocol (what `runHookPayload` carries) belongs to the boot (ticket 04); this is the shape the Alpine proof exercised: the
 * session PUBLIC key of the `builder` user. The agent serves the lifecycle hooks only (no diagnostics port) and honours `run` once.
 */
const hookAgent = `"""Software Factory guest hook agent: Lambda MicroVM lifecycle hooks on :9000. No diagnostics, no arbitrary execution."""
import json, os, subprocess, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {"started": False}

def on_run(raw):
    with LOCK:
        if STATE["started"]:
            return
        STATE["started"] = True
    try:
        payload = json.loads(json.loads(raw).get("runHookPayload") or "{}")
        key = payload.get("builder")
        if isinstance(key, str) and key.startswith("ssh-ed25519 ") and "\\n" not in key and len(key) < 1024:
            with open("/etc/ssh/authorized/builder", "w") as out:
                out.write(key + "\\n")
            os.chmod("/etc/ssh/authorized/builder", 0o644)
    except Exception as error:
        print(json.dumps({"hook": "run", "error": type(error).__name__}), flush=True)
    subprocess.Popen(["bash", "/opt/factory/start.sh"], start_new_session=True)

class Hooks(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        hook = self.path.rsplit("/", 1)[-1]
        if hook == "run":
            on_run(raw)
        print(json.dumps({"hook": hook, "bytes": len(raw)}), flush=True)
        body = b"{}"
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(("0.0.0.0", 9000), Hooks).serve_forever()
`;

const start = `#!/bin/bash
# Launched by the run hook, never at build time: nothing here is captured in the image snapshot.
exec >> /var/log/factory-start.log 2>&1
set -x
rm -f /etc/ssh/factory_host_ed25519*
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/factory_host_ed25519
mkdir -p /run/sshd /var/empty
/usr/sbin/sshd -f /opt/factory/sshd_config -E /var/log/factory-sshd.log
nohup websocat --binary -E ws-l:0.0.0.0:8022 tcp:127.0.0.1:22 > /var/log/factory-websocat.log 2>&1 &
# cgroup v2 nesting, required by dockerd inside the MicroVM's own container.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control || true
fi
mkdir -p /run/docker /var/lib/docker
nohup dockerd > /var/log/factory-dockerd.log 2>&1 &
for attempt in $(seq 1 60); do docker info > /dev/null 2>&1 && break; sleep 1; done
docker info > /dev/null 2>&1; echo "docker-info rc=$?"
# Declared images are pulled by digest at every boot; they are not part of the MicroVM image.
status=0
while read -r reference; do [ -n "$reference" ] || continue
  docker pull "$reference" || status=1
done < /opt/factory/declared-images > /var/log/factory-pull.log 2>&1
echo "boot-done pull=$status" > /var/log/factory-done
`;

const sshdConfig = `Port 22
ListenAddress 127.0.0.1
HostKey /etc/ssh/factory_host_ed25519
PidFile /run/factory-sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers builder
AuthorizedKeysFile /etc/ssh/authorized/%u
Subsystem sftp internal-sftp
ClientAliveInterval 20
ClientAliveCountMax 6
`;

export const guestFiles: Readonly<Record<'hook-agent.py' | 'start.sh' | 'sshd_config', string>> = Object.freeze({ 'hook-agent.py': hookAgent, 'start.sh': start, sshd_config: sshdConfig });
