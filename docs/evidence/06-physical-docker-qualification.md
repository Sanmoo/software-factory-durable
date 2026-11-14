# 06 — Qualificação física Docker/Testcontainers/TLS/reboot

Data: 2026-11-14. Branch `integrate/software-factory-mvp-06` (06 sobre a integração 01–05 + 04). Concessão: operador "06: Eu autorizo"; mudanças de perfil aprovadas explicitamente pelo operador (ver abaixo). Receita: `test/entrypoints/docker06-qualification.ts`. Cada etapa Bash roda pelo canal Builder `Sandbox.executeTool` do produto, vinculado ao boot próprio atual. Etapas em `docs/evidence/06-physical/`; observações (intent/result de cada etapa) em `$HOME/software-factory-test/y5/q06-qualification-v{1,2,3}`.

## Tentativas e adequações do perfil (todas preservadas)

| Tentativa | Assets | Resultado | Diagnóstico → adequação explícita |
|---|---|---|---|
| v1 | assets32 | sonda ok | `daemon.json`: bridge none, iptables/userland-proxy off |
| v2 | assets33 (`25a4f1d8…`) | portas publicadas ok; Ryuk falhou; Git falhou | Ryuk usa a rede bridge padrão → `No port binding found`; o FUSE mostra uid 1000 ao root do guest → Git `dubious ownership` |
| v3 | **assets34 (`8efa506a…`)** | **tudo verde, incluindo reboot** | — |

Mudanças aprovadas pelo operador, só no perfil do guest (fonte `src/sandbox/guest-profile/`, testadas em `sandbox-guest-profile.test.ts`): `userland-proxy: true`; remoção de `bridge: "none"`; `/etc/gitconfig` com `safe.directory = /workspace/*`. `iptables`, `ip6tables`, `ip-forward` e `ip-masq` continuam `false`. Proveniência em `$HOME/software-factory-test/assets3{3,4}/provenance.json`: só o rootfs mudou, com `e2fsck -fn` limpo. Kernel, initramfs e helpers são idênticos.

## Configuração e host

1 Work/ambiente novo por tentativa; 4096 MiB, 2 vCPU, 40 GiB; perfil `gondolin-qemu-alpine-dev-v1`; Alpine 3.23.7, kernel 6.18.58-0-virt, Docker 29.5.2 com vfs em `/var/lib/docker` (ext4 do disco persistente), cgroupfs, socket `unix:///run/docker.sock` só no guest. Host Linux, QEMU/KVM, user-manager systemd. `/var/lib/docker` usou ~545 MiB; rootfs 1.2 GiB de 39.4 GiB.

## Resultados v3 (expectativa → observado)

- **AC1 daemon próprio/vfs, sem Docker host:** driver `vfs`, data-root próprio, socket só local do guest; imagens puxadas pelo próprio daemon. ✔
- **AC2 Testcontainers + Ryuk reais:** `testcontainers@10.28.0` (lock sha256 `249772a5…`, integrity registrada), Ryuk `testcontainers/ryuk@sha256:2eaec4fc…` habilitado. Rede própria, alias DNS `fixture-service`, bind read-only do workspace FUSE, porta mapeada 8443→32770, wait strategy por log, cleanup próprio. Após o reboot, nenhum container com a label `org.testcontainers` sobrou. Escopo: API Testcontainers; **Compose/build não cobertos** (declarado). ✔
- **AC3 TLS em camadas:** ferramentas do guest com HTTPS público mediado (CA Gondolin por boot em `/etc/gondolin/mitm/ca.crt`); `apk` e `npm` via HTTPS; daemon com pull TLS (Docker Hub) por digest; aplicação dentro de container com HTTPS e CA sintética, e um segundo container validando pela truststore própria (`NODE_EXTRA_CA_CERTS`). Sem `--insecure` e sem `NODE_TLS_REJECT_UNAUTHORIZED=0`. ✔
- **AC4 reboot e filesystem:** boot1 → stop → boot2 no mesmo ambiente: marcador no rootfs, pacote apk `openssl`, repositório Git (HEAD `49da2997…`, `renamed.txt` 100755, `fsck --full` ok), `package-lock`, `node_modules` e cache do npm, imagens por digest, volume Docker `q06-persist` com o dado — tudo preservado, sem reclone ou reinstalação. O Git no FUSE cobre lock exclusivo `index.lock`, rename, modo executável e fsck. O Testcontainers rodou de novo após o reboot a partir dos caches. ✔
- **AC5 isolamento:** do guest, foram negados o gateway, 10/8, 172.16/12, 192.168/16, 169.254.169.254 e o IP LAN do host (192.168.0.183); HTTPS público passou pela mediação. De dentro de containers (bridge padrão e rede de usuário), host e redes privadas foram negados, e também não há saída pública (sem NAT). Cleanup só de recursos próprios (`docker stop`/`network rm` próprios, Ryuk); nada de `prune` ou limpeza global. ✔
- **AC6 incompatibilidades → diagnóstico e adequação explícita:** três incompatibilidades reais diagnosticadas na VM (portas, rede padrão do Ryuk, posse no FUSE). Cada uma foi resolvida com mudança mínima aprovada pelo operador, sem TLS inseguro, sem desligar o Ryuk, sem reescrever testes e sem fallback de sandbox. Musl: Node e npm do Alpine (musl) e imagem `node:22-alpine` funcionaram. ✔
- **AC7 registro:** manifesto e pins dos assets, configuração, host, comandos efetivos (scripts das etapas), versões, locks e digests, consumo observado. É uma fixture representativa, **não** a suíte real dos pilotos. ✔

## Lacunas declaradas

Compose e `docker build` não foram exercitados. O isolamento cobre os destinos sondados, não todo endpoint possível nem outro Trabalho simultâneo (não havia outro Trabalho ativo). O stop reporta `cessationConfirmed:true, termination:unconfirmed`, e isso não prova fechamento físico por FD. O teste `test/sandbox/gondolin.test.ts` segue `skip:true`.
