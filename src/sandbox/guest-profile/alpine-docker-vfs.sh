# Guest-only hook inserted by Gondolin before exec /usr/bin/sandboxd.
# Never source or execute this script on the host.
umask 077
mkdir -p /sys/fs/cgroup /var/lib/docker /var/log /run
if ! mountpoint -q /sys/fs/cgroup; then
  mount -t cgroup2 cgroup2 /sys/fs/cgroup
fi
test -r /sys/fs/cgroup/cgroup.controllers

# One daemon, no restart loop, no host socket or TCP listener.
dockerd --config-file=/etc/docker/daemon.json > /var/log/factory-dockerd.log 2>&1 &
# Bound the guest hook: a dead or wrong-driver daemon must not pass readiness.
timeout 10 /bin/sh -c '
  until [ "$(docker info --format "{{.Driver}}" 2>/dev/null)" = vfs ]; do
    sleep 0.1
  done
'
