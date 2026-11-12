# 03 — capacidade real e verificação do filesystem antes de novo boot

Incremento local após78643f5, sem VM, guest script, mount no host, nova imagem,
repair de dados preservados, download/instalação/sudo ou liberação de UNKNOWN.
Imagem base congelada assets32/pin4b6e inalterada. Crescer uma cópia por ambiente
para sua configuração de disco não modifica o template nem troca boot assets.

## Lacuna reproduzida

Read-only dumpe2fs do template:200960blocks*4096=823132160B (~785MiB), estado clean,
ext4 sem has_journal. prepare antes apenas qemu-imgresize alterava capacidade
virtual. SDK instalado não oferece resize2fs/e2fsck nesse caminho, e o guest
congelado não inclui resize2fs. Portanto40GiB virtuais não eram40GiB úteis de FS.

Regressão pública Sandbox.prepare com ext4 real32MiB, diskGiB1: RED
33554432B vs1073741824B, medida independente dumpe2fs da cópia RAW convertida do
qcow2 de saída. GREEN após crescimento da cópia. O template conserva SHA; repeat
prepare continua idempotente, mudança de configuração continua recusada.

## Implementação

- Nova preparação: owner/intenção privada antes dos efeitos, rawcopy exclusiva
  por ambiente, chmod600, extensão para capacidade alvo, e2fsck-fn sem reparo,
  resize2fs na CÓPIA NOVA, novo e2fsck-fn e geometria exata, conversão standalone,
  fsync do disco antes de ready. Só intermediário novo de sucesso é descartado;
  falha permanece incompleta/preservada, sem adoção/retry automático.
- Espaço livre considera conservadoramente as duas imagens de capacidade alvo
  e reserva mínima; não é quota/reserva física comprovada. Native helpers têm
  timeout30s, maxBuffer64KiB e ambiente sem credenciais. validate verifica
  existência executável de e2fsck/resize2fs sem instalar ou executar filesystem.
- Novo start: lifecycle lock, prévia cessação correlacionada quando existe boot
  anterior, disco privado/single-link/UID/mode seguro. qemu-info recusa backing e
  external data file/capacidade divergente; qemu-check não substitui ext4check.
  Snapshot RAW privado do qcow2, e2fsck-fn completo sem repair, geometria ext4
  conferida (inclui contador64bit), original dev/ino/size/mtimeNs/ctimeNs/UID/mode/
  nlink revalidados. Reobserva cessação anterior antes de publicar novo intent.
- Falha retém snapshot e recusa VM/manager; nunca repara o disco preservado ou
  torna namespace/PID desaparecido em nova autorização. Sucesso permite tentar
  novo boot pela mesma composição privada, não adotar VM antiga. Mantido código
  PRESERVED_DISK_CHECK_REQUIRED quando check não pode ser satisfeito.
- Imagens antigas pequenas não são migradas/reparadas silenciosamente. Crescer
  o disco de u3 ou outro recurso histórico não fez parte deste incremento.

## Cobertura local, não prova de restart

Cinco chamadas públicas Sandbox.start com discos reais/fake manager:
valid, corrupt (magic ext4 danificado), short-filesystem (virtual1GiB/fs32MiB),
backing-file, prior-unknown. Original SHA permanece idêntico após cada check;
casos negativos não publicam nova current nem chamam systemd-run. Só valid chega
à solicitação do manager DOUBLE que recusa com77: resultado indeterminate,
não boot operacional/sucesso de restart. O manager nunca tem fallback real.

Primeira execução desses casos falhou em4 por socket path longo da fixture,
antes do filesystem check. Corrigida exclusivamente a fixture para root novo
curto; nenhum afrouxamento no produto. Depois20casos focused de prepare/fs/start
passaram. Parse de metadados ext4 e ferramentas nativas não são execução de
programas do guest; nenhum filesystem é montado no kernel host. Continua a
existir dependência/confiança nos parsers nativos instalados, não contenção
formal deles. Fixtures/dados novos de teste descartados; históricos preservados.

## Aposentar diagnóstico temporário

Composição operacional agora usa console:none/debug:false/debugLog:null. Teste
na fronteira SDK exigiu isso (RED com stdio/protocol/callback antigo, GREEN após
remoção). Não há flag de worker para reativar. Comandos internos de perfil e
finalização também descartam stdout/stderr não usados, em vez de deixar o SDK
bufferizar dados guest desnecessários. Regressão externa SDK RED antes de ignorar
saída de perfil, GREEN depois; sem nova abstração ou exposição pública.
Snapshots privados existentes do
produtor passam a vazios: significam observação desligada, não guest que nunca
executou. Casos puros de allowlist limitada ficam preservados, sem usá-los como
prova de limite de heap do SDK. u3 permanece a prova histórica com instrumentação;
a composição sem console ainda precisa de qualificação de hardware própria.

Revisão independente única32d0bfff: nenhum P1/P2, OK com notas. Pontos não
exercitados dinamicamente: journal/recovery/externaljournal, mutação concorrente
da fonte e mudança de cessação durante o check. Perfil/testes atuais sem journal;
limites30s/64KiB são por processo, não prazo total; espaço observado não é reserva.
Gates finais:78casos77pass/1VMskip/0fail (~15.77s), strict compile/build,
arquitetura/ESLint67módulos289dependências e diff-check. LSP7arquivos sem achados
retornados, todos inconclusivos push-only; compilação estrita confirma os tipos.
Faltam qualificar hardware/guest finalization/restart/persistência e terminar
isolamento/owner-loss/projeção de ferramentas/remove. Sem aceite completo03,
integração/push/cleanup ou outro boot autorizado nesta rodada.

Qualificação posterior explicitamente autorizada: [v3](03-v3-two-boots-qualified-subset.md)
passou dois boots sequenciais com ext4 real40GiB, finalização guest observada e
estado Docker persistido, usando console desligado. Não promove isso a todos os
critérios03 nem a parada graciosa completa; orçamento posterior consumido.
