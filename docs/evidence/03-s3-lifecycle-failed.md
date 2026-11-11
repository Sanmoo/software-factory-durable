# Ticket03 — tentativa pública s3 com imagem corrigida: reprovada

Autorização consumida: uma VM,2GiB guest/2vCPU/40GiB virtual, root novo
`/home/sanmoo/software-factory-test/s3`, sem retry/reboot/fallback e com preservação
dos recursos anteriores. Fonte executada:
`45e830cf14caa17f07e9f327b6ffffdfbfc13d61`.

Imagem: `assets30/assets-final`, pin
`960b256c7c9f22a97428edf986ad6ff83affd5253e4fb6ba0c1579a0768c5d80`.
A [correção de empacotamento](03-apk-rootless-image.md) continua uma verificação
local válida; não foi promovida a prova de boot por causa disso.

## Preflight e tentativa única

Preflight em `s3-preflight-45e830c.json`: quatro checks públicos de integridade
passaram, memória disponível7821889536B, espaço disponível596152541184B, socket
previsto106B<=107. Root s3 não existia. Nenhum QEMU listado, sem liberar reservas
UNKNOWN históricas. Systemd user262.1 estava degraded por estado global não
atribuído exclusivamente a este caso; não se resetaram units antigas.

`prepare` passou. Environment:
`env-1f86ca8b06671c2cd9074ab41f7f19367217fefb84af1d88d90647e1fc9f11b8`.
Boot: `boot-fbcc1de8-9ce0-4481-87c6-6791b5937b6d`.

Witness capturado de VMM real, não `--version`: PID2293153, startTicks93783991,
no cgroup próprio, argv com kernel/initrd desse pin, disco próprio, `-accel kvm`,
`-m 2048M`, `-smp 2`, CPUhost e machinemicrovm. Isso registra processo e configuração,
não qualifica sozinho execução operacional do guest ou todos os recursos.

Start retornou `BOOT_ENDED_BEFORE_OPERATIONAL_CONFIRMATION`, diagnóstico real
privado e público **`vm-start / GUEST_READINESS_TIMEOUT`**. Não houve
`operational.json` nem check posterior de Alpine/Docker-vfs.

`before-stop`: stopped/cessationConfirmedtrue. `stop`: success, porém já estava
parado; terminationunconfirmed, guestFinalizationunavailable. `after-stop`: stopped.
`result.json`: `operationalBoot:false`, `activeBeforeStop:false`,
`qualifyingVmmWitness:true`, **`accepted:false`**, sem restart/removal.

## Cessação própria e preservação

`manager-final.json`, leitura independente após a tentativa:

- Unit exata `factory-sandbox-boot-fbcc1de8-9ce0-4481-87c6-6791b5937b6d.service`.
- Invocation `6bd7639eaa8e429fae647d9f3e303350`, igual a started.json; hostBoot
  também conferido. Namespaces cgroup4026531835/mount4026531832 coincidem.
- ExecMainStart06:19:36/Exit06:20:08 UTC-03 em2026-11-11; exit1, result exit-code,
  ActiveStatefailed, MainPID0 e ControlGroup vazio.
- Cgroup exato ausente, hierarquia/controllers disponíveis; nova observação
  pública confirmou cessação. Não depende apenas de SDK.close ou PID ausente.
- MemoryPeak247136256B e CPUUsage32821127000ns são contadores do escopo, não
  medição da RAM guest/vCPU qualificada. Nenhum QEMU listado no inventário posterior.

Disco/records/runtime/failed unit retidos. Uso físico observado26982264832B, abaixo
de80GiB; não é quota rígida nem liberação de reservas antigas. Nenhuma unit antiga
foi sinalizada/removida; nenhum cleanup/push/integração parcial foi feito.

## Inspeção sem outro boot e limite do diagnóstico

Depois da cessação correlacionada, `qemu-img compare -f qcow2 -F raw` comparou o
disco preservado ao template deste pin, somente leitura. Exit0, com mensagens
**`Warning: Image size mismatch!`** e `Images are identical.` O disco virtual tem
40GiB, maior que o template; essa comparação permite tail de zeros. Não se detectou
diferença lógica persistida; não é igualdade bit a bit dos arquivos nem prova de
que o guest nunca executou. O template comparado não contém
`/var/log/factory-dockerd.log`; não se recuperou um log do daemon deste caso.

O adapter atual usa `console:none`, `debug:false`, `debugLog:null` e descarta
stdout/stderr da unit. O código seguro preserva timeout do SDK, mas não identifica
o último estágio interno do boot/control/VFS. A repetição com coorte58 e banco
APK corrigido **não autoriza atribuir a causa ao kernel, Docker, módulos ou disco**.
Não se justifica outra troca de imagem ou aumento de timeout sem novo sinal.

A reprodução real pública já foi vermelha; repetir/minimizar em hardware não é
permitido pela autorização consumida. Falta um feedback loop estreito autorizado
que distinga kernel/initramfs/root/sandboxfs/Docker/sandboxd. Próxima proposta:
observabilidade privada de marcadores literais de estágio, limitada e sem conteúdo
bruto do guest, por interfaces já existentes do SDK; qualquer nova VM exige outra
autorização explícita. Nenhuma instrumentação ou VM adicional foi executada.

Gates locais antes do ensaio:55 casos,54pass/1VMskip/0fail; typecheck/build e
arquitetura/ESLint (63 módulos/270 dependências) passaram. Não compensam o resultado
real reprovado. Ticket03 permanece incompleto; destino integration/software-factory-mvp
continua em b591ec7 e a worktree de implementação permanece preservada.
