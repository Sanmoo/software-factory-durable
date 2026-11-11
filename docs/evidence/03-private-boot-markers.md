# Ticket03 — observabilidade temporária do cold boot

Autorização desta etapa: preparar marcadores privados limitados, sem mensagens
brutas/agents/credenciais, e depois **uma** VM de diagnóstico com a mesma imagem
960b256c...,2GiB/2vCPU/40GiB virtual, root novo t3. Nenhuma VM foi iniciada neste
checkpoint de fonte; tentativas anteriores permanecem preservadas.

## Feedback que faltava

[s3](03-s3-lifecycle-failed.md) reproduziu `vm-start/GUEST_READINESS_TIMEOUT`, mas
console/debug desligados não permitiram distinguir progresso inicial. Não se
atribuiu causa ao kernel/Docker nem se trocou imagem/aumentou timeout. O ensaio
real é vermelho, mas a autorização não permite loops de VMs: testes locais dos
marcadores não são uma reprodução completa nem correção do bug de hardware/guest.

## Recorte da fonte

- `src/sandbox/boot-markers.ts`: recebe callbacks normalizados do SDK, considera
  somente `qemu`/`stdout: `; ignora protocol/exec/error/stderr e objetos não-string.
  Callbacks maiores que4096 unidades UTF-16 não são copiados/processados. Contadores
  saturam1024, não há remontagem de chunks ou retenção de conteúdo. Set tem somente
  14 possíveis códigos fixos; snapshots são defensivos. Nenhum timestamp/path/
  mensagem derivado do guest é persistido.
- `adapter.ts`: usa interfaces existentes console stdio/debug protocol/debugLog.
  Uma única Promise publica `boot-markers.json` privado/versionado/correlacionado
  ao boot, via mesmo writer durável. Coleta é selada e callback desligado antes do
  primeiro comando guest, ou na rejeição de startup antes de failure.json/close.
  Parada concorrente espera a mesma publicação; falha no diagnóstico não impede
  a tentativa de fechamento. Publicação/cessação não são equiparadas.
- Nenhum método novo na facade Q5, campo YAML ou flag livre de worker. DTO público
  de failure mantém fase/código seguros, sem mensagens brutas. Marcadores não
  controlam aceitação de boot/stop, reinício ou liberação de capacidade.

Códigos são **observações de texto**, não verdade sobre progresso/causa. Podem ser
imitados pelo guest; ausência é desconhecida, não prova de que um estágio não rodou.
Em especial `[init] starting sandboxd` é emitido antes do hook Docker injetado:
registrado como `pre-sandboxd-hook-text`, nunca como exec bem-sucedido do sandboxd.

## Limites de segurança e aplicação

O limite acima cobre o estado/registro mantido pela Factory. **Não limita a heap
ou todo buffering interno do SDK**: Gondolin0.14 concatena stdout até newline em
`SandboxServer`, antes do callback. Esta ativação é temporária nesta branch isolada,
para cold boot da imagem fixada, sem workers/agentes/credenciais e com stop logo
após observação. `setDebugLog(null)` impede nossa coleta após readiness, mas não
reescreve o argumento serial nem corrige o buffering interno. Não distribuir ou
integrar esse modo para workloads de workers não confiáveis; remover ativação ou
resolver o limite na integração antes de habilitar esses workloads. Sem SDK fork.

Systemd continua descartando stdout/stderr da unit. O callback não imprime nada;
arquivo contém só códigos/counters. Não gravar um tail bruto como fallback.

## Testes antes da VM

Cinco casos puros: observações/allowlist, initramfs/panic sem fabricação de proof,
repetições/oversized, seal defensivo e ausência de callbacks. Stub inicial RED4
antes do matcher, depois GREEN5. Três casos novos exercitam o entrypoint real com
fronteiras SDK/processo externas dubladas: publicação lenta antes de close,
falha de write ainda fecha uma vez e sucesso de SDK sela antes de exec/ignora
callback tardio. RED3 antes da integração no adapter, depois GREEN3. Junto com
quatro casos existentes de startup/close:12pass/0fail no focused run.

São children Node novos, mock de módulo experimental restrito ao teste, spawn de
VMM proibido, manager fake sem PATH fallback; nenhum SDK VMM, sinal OS, guest hook
ou unit real nesses testes. Canário não aparece em stdout/stderr nem nos JSONs.
Compiler/build/arquitetura/ESLint e diff-check passaram no checkpoint local.
Revisão independente única `9a6d7806`: sem achados P1/P2 no recorte temporário,
com notas explícitas sobre buffering interno do SDK e proibição de promover esse
modo a workloads não confiáveis/integração. Não é liberação de runtime/release.
Gates completos antes da VM:63 casos,62pass/1VMskip/0fail (~9.56s),
compilação estrita/build/arquitetura/ESLint (65 módulos/274 dependências) e diff-check.
LSP6 arquivos sem achados retornados, mas todos inconclusivos (push-only);
compilação estrita confirma os tipos. A única tentativa real continua pendente
neste checkpoint de fonte.

Execução posterior autorizada: [t3 entregou marcadores reais, mas falhou readiness](03-t3-diagnostic-failed.md).
O sinal capturado não foi convertido em diagnóstico causal ou aceite do lifecycle.
