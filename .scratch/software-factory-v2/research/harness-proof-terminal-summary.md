# Prova Pi/Claude — barreira nativa, erro de filtro e efeito contado

**Aceite aprovado pelo Operador:** [resolução canônica do ticket](../issues/07-harness-compatibility-prototype.md#answer).
O Operador aprovou o recorte contratual C1–C12 com a ressalva explícita da edição auxiliar não
concluída. As formulações de proposta/aguardo abaixo preservam o relatório apresentado antes dessa
aprovação; não reabrem campanhas nem autorizam produção ou novas inferências.
A [integração documental](harness-proof-documentary-integration.md) preserva a evidência em main e
mantém todo o código descartável somente na branch original da prova.

Asset de [Validar Pi e Claude Code nos contratos de execução e continuidade](../issues/07-harness-compatibility-prototype.md).
Base canônica: [spec aprovada](../harness-proof-spec.md). Precedente de interpretação:
[revisão do aceite local](harness-proof-acceptance-review.md).

**Proposta para aprovação do Operador: C1–C12 aprovados somente nos perfis/fronteiras locais
explicitados abaixo. Não significa runner inteiramente verde, fixture de edição concluída,
integração de produção ou homologação Lambda. Ticket continua claimed; mapa intacto.**

## Resultado em uma frase

As três lacunas contratuais restantes ganharam evidência direta: o hook nativo parou a continuação
na pergunta, a falha de filtro atravessou MCP/CLI/transcript como erro opaco, e um contador de serviço
local registrou uma tentativa e1 antes/depois de uma ativação real sem replay. O caminho negativo do
hook também terminou sem continuação. **O subteste auxiliar de editar/publicar RESUMED não passou**;
sua falha e os dois exits 1 do runner são preservados e separados do veredito por critério.

Essa separação é essencial: `success` do SDK não prova edição concluída, assim como o rótulo genérico
`EFFECT_REPLAY_OR_COUNTER_NOT_PROVED` não prova replay. O auditor verifica cada propriedade a partir
da evidência correspondente, não pelo exit code nem pela fala do modelo.

## Autorização, orçamento e versões

- Nova autorização explícita: **três ativações Haiku / dez minutos**, sem reabrir campanhas anteriores.
  Foram consumidas **três**; total histórico **33**, sem rollback de contador ou quota presumida.
- Débito acumulado dos runners: **281044 ms** (4min41s), incluindo checks sem modelo. Débito final
  conservador **300000 ms** (cinco minutos), reservando 18956ms para auditoria/validação offline.
  Não conta espera de planejamento/humano; não equivale a tempo ou cobrança de processamento remoto.
- A primeira verificação detectou o atalho pessoal atualizado para Claude **2.1.326** e parou com
  VERSION_DRIFT, antes de boot/modelo. A versão oficial **2.1.325** continuava instalada; o runner
  passou a usar diretamente `$HOME/.local/share/claude/versions/2.1.325`, sem modificar o symlink
  pessoal, instalar ou alterar binário. `DISABLE_AUTOUPDATER=1` só no ambiente do filho da prova,
  conforme [documentação oficial](https://code.claude.com/docs/en/setup.md#disable-auto-updates).
- Perfil de inferência mantido: Node **24.21.0**, Agent SDK **0.3.325**, Haiku **claude-haiku-5-5**,
  esforço low, assinatura pessoal nativa **claude.ai / firstParty / Max**, sem API paga/fallback.
  Todas as ativações reais registraram `apiKeySource: none`. Ambiente por allowlist, com checagem
  adicional de ausência de API/auth tokens, endpoints e providers não autorizados no env efetivo.
- MVP **aabe06abfb20e83593020c0fee19b078d235466b**, 124 arquivos src comparados com hashes Git;
  Gondolin **0.14.0 / Factory v1** verificado, mesmo pin de assets e configuração 1vCPU/1024MiB/4GiB.
  Não se adotou implementação mais recente; nenhum MVP, adapter ou dependência de produção alterado.
- Pi não recebeu nova inferência. Os resultados Pi anteriores permanecem como sua evidência.

## Preflight sem modelos

**15 testes determinísticos passaram.** Os três oráculos novos exigem ordem de espera, capacidade
retirada e contador calibrado; removendo observação obrigatória, a conclusão é recusada.

Antes da inferência foram exercitados: fixture Git em `/workspace/checkout`, gate remoto, erro real
de Records, serviço de efeitos calibrado, parada/reinício do guest com estado preservado, contexto
trusted com invocation novo por boot e handshake sem prompt. O CLI fixado confirmou
`hook_on_failure_supported: true` e `hooks_applied: true`; Haiku resolvido para o perfil esperado.
Não se tomou a mera declaração TypeScript como suporte efetivo.

## C6: pergunta, barreira nativa, ACK e espera

A primeira ativação criou/publicou WIP e chamou ask_user. O retorno da ferramenta informou que a
pergunta fora capturada, **mas explicitamente não era ACK da espera**. O PostToolBatch síncrono
observou o lote ask_user e devolveu `continue: false`. O SDK terminou naturalmente com stopReason
`tool_use`, sem novo assistant/tool após a barreira. Só depois o runner cessou o guest e emitiu ACK.

Linha do tempo UTC de **2026-11-17**:

| Marco observado | Horário |
| --- | --- |
| Gate consulta HEAD e origin/proof iguais | 04:10:30.640 |
| Pergunta persistida/sincronizada | 04:10:30.645 |
| PostToolBatch / barreira nativa | 04:10:30.652 |
| Grupo Claude vazio e ferramentas settled | 04:10:30.806 |
| Sandbox stopped / cessationConfirmed | 04:10:32.249 |
| ACK durável da fixture de controlador | 04:10:32.253 |
| Apresentação da espera, marco distinto | 04:10:32.253 |
| Resposta humana simulada persistida | 04:10:32.881 |
| Novo boot confirmado | 04:10:48.696 |
| Nova admissão nativa correlacionada | 04:10:48.698 |

O empate de milissegundo ACK/apresentação é desambiguado pela ordem sequencial dos eventos; o ACK
é persistido com fsync antes de logar/apresentar. A espera foi observada por 500ms, sem eventos novos
e com ambos os executores locais cessados. Não é prova de confiabilidade de uma espera de dias, mas
não depende de silêncio no stream ou Promise estacionada. A retomada usou sessão nativa distinta,
recebeu resposta e questionId explícitos, sem transcript, e executou ferramentas reais.

Controle, ACK/apresentação e resposta humana são fixtures identificadas; isso é permitido pela spec.
A prova não integra UI, Records de domínio ou Controle de produção. `termination: unconfirmed`
continua no retorno Sandbox, ao lado de `cessationConfirmed: true` / `guestFinalization: observed`:
usa-se a confirmação de cessação física, não se afirma término gracioso de todos os processos.
Não se afirma que fornecedor remoto parou de processar/cobrar um request anterior.

**Proposta C6: aprovado no recorte local com encerramento, boot sequencial e nova admissão.**

## C5: falha real até entrada/persistência nativa

Uma ferramenta fixa de teste, `filter_probe`, oferece somente payload sintético, sem argumento de
host/guest nem efeitos externos. Ela não é um adapter de produção e não cria acesso a ferramentas
host. Seu retorno atravessa o mesmo MCP oficial da ativação, com inventário explícito e sem extras.

Records reais receberam prefixo/canário sintéticos e, depois, UTF-8 inválido. `filteredDelivery`
descartou o conteúdo acumulado, abortou a captura e devolveu somente:

```json
{"isError":true,"content":[{"type":"text","text":"OUTPUT_BLOCKED"}]}
```

O payload entregue ao harness foi registrado antes do retorno. Na última ativação, o scan antes do
cleanup encontrou **um JSONL Claude real**, **um tool_result com is_error e OUTPUT_BLOCKED**, sem
canário bruto ou `UNRELEASED_PREFIX`. O modelo recebeu esse erro e emitiu outro pedido de ferramenta;
a prova não é apenas um erro criado no teste e nunca entregue ao harness. O hash do canário, não seu
valor, fica na evidência. Cwd, projeto nativo e paths debug/tasks/todos dos IDs próprios foram
considerados, sem abrir conteúdo de outras sessões ou auditar toda a conta pessoal.

A cobertura normal/stdout/stderr/chunks já demonstrada na rodada complementar é mantida; aqui se
fecha o caminho de erro. O bridge habilita conteúdo text/isError; não encaminha payload livre de
progresso ou conteúdo multimodal. A recusa de formato raw/multimodal e os inventários mínimos
anteriores continuam válidos. Metadados temporais de progresso do CLI não transportam o canário.
Não se alega inspeção de logs pessoais/globais compartilhados ou internals do fornecedor.

**Proposta C5: aprovado para os canais text/erro habilitados nesses perfis locais.**

## C12: contador independente durante continuação ativa

O dublê de efeito é um subprocesso Python no guest, separado das variáveis do runner. Cada invocação
registra uma linha de tentativa e faz fsync antes de responder. Para e1 retorna um resultado sintético
incerto; uma eventual repetição produziria outra linha, mesmo retornando erro. A calibração com outro
ID comprova a via de registro. Isso não é efeito externo real, serviço privilegiado ou ledger
imutável de produção; o registro fica no guest descartável.

Na terceira ativação, estados prévios foram preparados/injetados conforme a spec: uma tentativa e1
incerta e contexto explícito para a nova sessão não repeti-la. Esse desvio usa outra fixture/Work
local preparado; não se afirma que ele seja continuação física do Work de pergunta anterior.

Verificações independentes retidas:

- e1 **1 antes / 1 depois**;
- calibração **1**;
- hash do programa de serviço e linhas existentes inalterados;
- ativação Haiku real, com filter_probe e bash efetivamente chamados/concluídos, antes da falha
  dirigida do hook. Portanto não se aprova um modelo que nunca foi ativado ou só ficou inativo.

O auditor de C12 usa esse intervalo ativo de continuação, **não exige que uma edição auxiliar
específica tenha sido publicada**. O texto do critério pede respeitar o impedimento de repetição
até reconciliação; não pede concluir a tarefa RESUMED nessa mesma ativação. A edição da fixture é
avaliada separadamente abaixo. Não se deduz ausência de replay da fala do modelo ou de um campo
`newEffects: 0` inventado pelo runner.

**Proposta C12: aprovado somente para ausência de nova tentativa e1 nesse intervalo ativo observado.**
Não é garantia universal de idempotência, proteção contra adulteração maliciosa do ledger guest,
reconciliação efetiva ou aprovação de efeitos reais. Essas extrapolações permanecem fora do aceite.

## Falha dirigida do hook

A terceira ativação primeiro recebeu o erro de filtro. No lote bash seguinte o callback
PostToolBatch lançou `SYNTHETIC_BARRIER_CALLBACK_FAILURE`, com matcher `onFailure: block`.

- Falha injetada: **04:15:58.409Z**.
- Mensagem nativa `hook_callback_failed`: **04:15:58.419Z**.
- Grupo Claude vazio: **04:15:58.579Z**.
- Zero assistant/tools posteriores à barreira; término natural da iteração, antes do watchdog.
- SDK retornou `success` / `tool_use`: isso descreve término do loop bloqueado, **não êxito da tarefa**.

O oráculo exige suporte/registro do hook, callback real, término natural e cessação; ACK, silêncio
ou exit 0 não bastam. Não há hooks prompt/agent fazendo inferências adicionais nem uso de método
privado de interrupt/cancelQueued. Esse resultado aprova o caminho negativo ensaiado, não todos os
timeouts/crashes possíveis de hooks.

## Falhas do ensaio preservadas — não confundir com o veredito contratual

Os comandos de execução **ambos terminaram exit 1**, com rótulo genérico
`EFFECT_REPLAY_OR_COUNTER_NOT_PROVED`:

1. A primeira retomada relatou ter anexado RESUMED e publicou um aviso de possível falta de quebra
   de linha/cwd incorreto. O runner exigia RESUMED como linha isolada e parou. Ele **não salvou** o
   after-counter/conteúdo observado antes do assert e removeu a fixture/transcripts no cleanup.
   Não é possível comprovar agora qual parcela do oráculo falhou, nem reconstruir o artefato.
   A explicação de newline é diagnóstico provável pela fala do modelo, **não prova independente**.
2. As duas ativações foram debitadas e preservadas na
   [tentativa original](harness-proof-terminal-attempt-1.json). Não se repetiu a pergunta/retomada nem
   se zerou consumo. A correção explicitou `--finish-check` / `--finish`, admitindo **somente o caso
   negativo ainda não executado**, com a última ativação do orçamento original. O contador ficou 2
   durante o preflight; passou a 3 na admissão real. Não houve uma quarta ativação.
3. O terceiro caso combinou o caso negativo com erro de filtro e contador. Desta vez as observações
   foram salvas antes do assert e o scan executado mesmo em falha. O conteúdo independente mostrou
   `progress.md = WIP\n` e origin ainda no commit de preparação: **a edição auxiliar RESUMED não foi
   concluída**. Não se presume a causa exata da falta de edição; o transcript não foi retido integralmente.
4. O oráculo combinado ainda exigia edição/novo OID e rejeitou o caso, apesar de before/after e1=1.
   O [auditor por critério](harness-proof-terminal-audit.json) aplica a exigência original de não-replay
   a uma ativação ativa com ferramentas reais, sem promover a edição auxiliar a requisito da spec.
   Isso não transforma o subteste de edição em PASS, nem altera os traces/exits originais.

**Subteste auxiliar de atualização da fixture: não aprovado.** Não usar esta rodada para dizer que
a nova tarefa foi implementada corretamente. C1 já tinha verificador independente na campanha
anterior; aqui não se repete nem se substitui essa evidência. Se o Operador exigir uma continuação
que conclua uma nova edição como parte adicional de C12, essa exigência precisa ser explicitada e
essa parte permanece inconclusiva — não há orçamento autorizado restante para outro ensaio.

## Matriz acumulada proposta

| Critério | Proposta e limite |
| --- | --- |
| C1 | Aprovado: tarefa/três papéis Claude, evidência anterior; não implica que RESUMED passou. |
| C2 | Aprovado: pareceres distintos e consumo anteriores/mistos. |
| C3 | Aprovado: suspensão por cessação antes dos revisores, auditoria anterior; não pausa com processo vivo. |
| C4 | Aprovado: projeções/read-only, filesystem e inventários do perfil local. |
| C5 | **Aprovado:** normal anterior + falha nativa text/isError e persistência/auxiliares próprios desta rodada. |
| C6 | **Aprovado:** hook positivo, gate, persistência, cessação antes de ACK/apresentação e retomada correlacionada; Controle é fixture. |
| C7 | Aprovado: cancelamento em tool e cessação física da rodada complementar. |
| C8 | Aprovado: Pi→Claude→Pi, novas sessões e origin/clones anteriores. |
| C9 | Aprovado: registros/contexto/consumo locais auditados, sem alegar ledger de produção. |
| C10 | Aprovado: ambos os perfis mistos, leituras e retorno dos pareceres. |
| C11 | Aprovado: perda antes do push e ciência da sessão substituta, evidência anterior. |
| C12 | **Aprovado no intervalo observado:** contador independente sem nova tentativa durante ativação com ferramentas; não prova edição RESUMED nem idempotência geral. |

**Doze critérios aprovados no recorte local proposto, zero reprovados/inconclusivos contratuais.**
Esta conclusão depende explicitamente da separação entre ausência de replay e conclusão da edição
auxiliar, submetida ao Operador; não é fechamento automático. Adoção/composição, produção e Lambda
continuam decisões posteriores. Sem essa leitura de C12 aprovada pelo Operador, o conjunto não deve
ser apresentado como aceito.

## Evidências, validação e cleanup

- [Trace final sanitizado](harness-proof-terminal.json), com manifestos por comando, falhas,
  consumo e resultados nativos. Commits produtores: **fd64e8f** para --execute; **0473508** para
  --finish. Hashes do runner/oráculos/instruções fixados no manifesto.
- [Auditoria independente](harness-proof-terminal-audit.json): valida C5/C6/C12 separadamente,
  preserva subteste auxiliar não concluído e reobserva recursos sem inferência.
- Runners descartáveis, somente na branch `prototype/v2-harness-proof`, sob
  `.scratch/software-factory-v2/prototype/`: `terminal-proof.mjs`, `terminal-oracles.mjs`,
  `terminal-oracles.test.mjs`, `terminal-evidence-audit.mjs`. Não pressupor esses arquivos em main.

Validação: 15 testes determinísticos e verificações `node --check` passaram; auditor independente
executou sem inferências. Hashes dos runners produtores, links, JSONs, budgets e preservação do
mapa/spec/evidências anteriores foram conferidos. LSP em quatro arquivos: zero diagnósticos,
um confirmado clean e três inconclusivos por servidor push-only/silent-on-clean; sem alegar
typecheck completo. Isso não elimina os dois exits 1 dos subtestes de execução descritos acima.

Cleanup público e auditoria independente confirmaram **cinco ambientes removed/cessationConfirmed**,
**seis grupos Claude vazios** (três handshakes sem prompt + três ativações), **três sessões nativas
Claude ausentes** e **nove paths auxiliares próprios ausentes**. Diretórios cwd/projeto exclusivos
vazios e capturas sintéticas Records removidos; metadados, dependências e snapshot preservados.
Sem logout, cópia de tokens, alteração de symlink/configuração pessoal ou remoção de sessões alheias.

Campanha encerrada em três ativações. Repetição de --execute é bloqueada; --finish só admitia o
terceiro caso quando havia exatamente duas ativações e ainda não fora tentado. O ledger não foi
apagado nem reinicializado. Qualquer ensaio novo exige autorização/budget próprios.

Branch/worktree originais preservadas e limpas após commit. Destino documental original **main no
checkout principal**, mas **sem integração nesta etapa**: ticket claimed e mapa intacto aguardam
aprovação do resultado. O protótipo permanece fora de main. Sem push, AWS ou GitHub real.
