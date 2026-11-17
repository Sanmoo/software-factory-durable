# Prova Pi/Claude — revisão do aceite local sem novas inferências

**Resultado posterior:** consultar a [rodada de barreira nativa](harness-proof-terminal-summary.md),
executada após autorização separada de três ativações/dez minutos. Ela propõe fechar C5/C6 e o
recorte observado de C12, mas preserva dois exits 1 e um subteste auxiliar de edição não concluído;
a interpretação/aceite continuam sujeitos à aprovação do Operador. A revisão abaixo é histórica.

Asset de [Validar Pi e Claude Code nos contratos de execução e continuidade](../issues/07-harness-compatibility-prototype.md).
Revisa a interpretação da [proposta complementar](harness-proof-complement-summary.md) contra a
[spec aprovada](../harness-proof-spec.md), sem alterar a spec nem apagar evidência anterior.

**Proposta atual para aprovação do Operador: nove critérios aprovados no recorte local, três
inconclusivos, zero reprovados. Conjunto ainda INCONCLUSIVO. Ticket claimed; mapa intacto.**

## Escopo e recursos

O Operador concordou com revisar o aceite e investigar os mecanismos de suspensão antes de decidir
sobre outra rodada. Esta etapa enviou **zero prompts**, iniciou **zero processos nativos de harness**,
criou **zero boots/VMs** e não mudou credenciais, dependências ou referência MVP.
As campanhas permanecem encerradas em 20 + 10 ativações. Nenhum orçamento foi reutilizado ou ampliado.
A pesquisa usou somente leitura de tipos/código do SDK já instalado, documentos oficiais e um
validador offline dos JSONs sanitizados retidos. Não houve subagente ou inferência de pesquisa.

## Correção da interpretação anterior

A spec autoriza expressamente:

- encerramento de ativação como mecanismo de suspensão;
- registros/estados de teste mínimos e resposta humana simulada;
- avaliação delimitada ao perfil local, sem alegar Controle integrado ou durabilidade de produção.

Portanto, **ausência de Controle/ledger de produção não é um motivo autônomo para C6 ou C9 ficarem
inconclusivos**. Da mesma forma, a API não oferecer um contador universal de requests não impede
provar C3 por cessação física **anterior à barreira já registrada**, no cenário de revisão.
Não se moveu a barreira retroativamente nem se passou a aceitar silêncio/exit 0 como cessação.

A ressalva da spec sobre API que só expõe stream continua válida quando a ausência de novos requests
não pode ser estabelecida por outro oráculo. No intervalo de revisão da rodada complementar temos
um oráculo adicional: o Builder já estava cessado/disposto antes de admitir qualquer revisor.
Isso não resolve automaticamente o intervalo de pergunta/ACK, que tem ordem diferente.

## C3: aprovação local sustentada pela linha do tempo existente

O [validador offline](harness-proof-acceptance-review.json) verificou os dois arranjos:

| Builder | Cessação/dispose | Barreira de revisão | Primeiro revisor admitido | Retorno do Builder |
| --- | --- | --- | --- | --- |
| Claude | 09:32:30.867Z | 09:32:31.127Z | 09:32:31.148Z | 09:32:46.586Z |
| Pi | 09:32:59.377Z | 09:32:59.527Z | 09:32:59.527Z | 09:33:10.738Z |

Tempos UTC de 2026-11-16. O empate de milissegundo no segundo arranjo é desambiguado pela ordem do
array de eventos do runner sequencial: a barreira precede a admissão. O primeiro validador offline
exigiu timestamp estritamente maior e falhou nesse empate; foi corrigido para verificar também a
ordem de programa, sem modificar os eventos originais.

Para Claude há inventário do grupo próprio vazio e ferramenta settled antes da barreira; o MCP
é in-process no runner e não oferece tarefa autônoma/delegação. Os handlers verificam abort e não
há builtin/servidor extra. Para Pi há dispose e gate pré-request fechado. O auditor não encontrou
novos eventos de tool/request/admissão da ativação antiga no intervalo dos revisores. O retorno foi
uma nova admissão com outro identificador, não continuação oculta da ativação antiga.

A ausência de eventos, isoladamente, não aprovaria C3. Ela é corroborada aqui pela retirada física
ou lógica da capacidade da ativação anterior. Pedidos remotos já enviados podem continuar sendo
processados/cobrados pelo fornecedor; isso não é um novo request iniciado pelo Builder durante a
revisão e permanece consumo desconhecido, conforme a própria spec.

**Reclassificação proposta: C3 aprovado apenas para suspensão por cessação deste perfil local.**
Não aprova pausa com processo vivo, outros mecanismos de background ou uma API universal de suspensão.

## C9: aprovação no escopo permitido de registros locais explícitos

Foi retirada a exigência indevida de testar o Controle de produção. Em seu lugar, o auditor compara
os registros preservados das tentativas [P1/C2](harness-proof-attempt-7.json),
[reserva falha](harness-proof-attempt-8.json) e [P3](harness-proof-attempt-9.json):

- `work.id = harness-proof-local-v7` e limite 20 mantidos;
- prefixo do histórico, perguntas e efeito e1 pendente preservados; histórico só recebe o registro
  explícito de perda local;
- campo de consumo anterior 17 mantido como baseline histórico, **não confundido com total atual**;
- admissões efetivas 18 → 19 → 20, sem reinício; a reserva falha antes de sessão/modelo continua
  excluída segundo a contabilidade já documentada, não tratada como quota devolvida;
- tempo debitado não diminuiu; usage anterior continua na evidência original;
- contextPacket do runner fornece registros e consumo acumulado, sem transcript ou resumo anterior;
- três sessões nativas distintas, novos clones e boots distintos; P1/C2/P3 presentes no remoto final;
- P3 usa `earlier.work` lido do registro anterior, não um novo work fictício; o estado local foi
  comparado antes/depois do harness e ficou inalterado, salvo a alteração de histórico autorizada.

Isso é mais do que uma autodeclaração do modelo: combina registros, fluxo do runner e verificações
Git reais. É uma observação finita do roteiro, não prova de um ledger geral resistente a crash,
reconfiguração arbitrária de limites ou cobrança remota exata. Esses últimos não são o aceite desta
prova. Um teste negativo de admissão no limite seria fortalecimento útil, não requisito novo para
reconhecer o que já foi observado.

**Reclassificação proposta: C9 aprovado no recorte de contexto/registros e contabilidade local do
roteiro.** O componente de Controle continua identificado como fixture, sem homologação de produção.

## Por que C5, C6 e C12 ainda não podem ser aprovados

### C5 — lacuna de entrega nativa em falha, não auditoria de toda a conta

Não é necessário examinar todos os logs pessoais/globais compartilhados do Operador nem internals
do fornecedor. A fronteira exigida é a entrada/persistência nativa e auxiliares **próprios do perfil**.
A rodada já mostrou saída normal/stderr/chunks redigida e um JSONL Claude real sem canário bruto.
Mas a falha UTF-8 foi observada em Records/bridge, sem uma chamada nativa completa de erro que
mostrasse a mesma propriedade até transcript/auxiliares. Essa lacuna é concreta e local.

Foram conferidos, por metadata e somente para os seis IDs próprios conhecidos, os caminhos
`.claude/debug/<id>.txt`, `.claude/tasks/<id>` e `.claude/todos/<id>-agent-<id>.json`: todos ausentes
no estado atual. Isso complementa cleanup, **não comprova retroativamente seu conteúdo durante a
inferência**. Nenhum arquivo de outra sessão foi aberto ou removido.

### C6 — o ACK antecede a cessação, sem uma barreira nativa comprovada no intervalo

Na tentativa de pergunta: durable/ACK em **01:06:28.530Z**, stop confirmado apenas em **01:06:30.632Z**.
O runner marca `barrier=true` no ACK e em seguida chama abort/close. Não há oráculo suficiente para
excluir novos requests nesse intervalo de cerca de 2,1s. A resposta humana simulada só é injetada
depois do retorno da ativação; porém falta também um marco explícito de apresentação/espera após
reconciliação. Não se pode mover o ACK histórico para depois da parada para aprovar a prova.

Gate Git, persistência com fsync e retomada positiva já têm evidência. A lacuna não é o ACK ser
fixture: é provar a ordem dos marcos e a exclusão de atividade depois da barreira.

### C12 — falta contador independente

O código declara `newEffects: 0`, mas não há um endpoint/script/serviço de efeitos que registre as
tentativas. A fala do modelo e um boolean do mesmo runner não mostram que o efeito não foi repetido.
A spec permite dublê de serviço local; não exige efeito real em GitHub ou outro provedor.

## Investigação dos mecanismos nativos Claude

### Fontes primárias e perfil

- [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks.md): callbacks síncronos, falha e timeout.
- [PostToolBatch e controle](https://code.claude.com/docs/en/hooks.md#posttoolbatch): evento entre lote
  de ferramentas e próxima chamada ao modelo.
- [JSON output](https://code.claude.com/docs/en/hooks.md#json-output): `continue: false` e diferenças
  de semântica por evento.
- [TypeScript Query](https://code.claude.com/docs/en/agent-sdk/typescript.md#query-object): métodos
  de controle e mensagens.
- Tipos/código da instalação local Agent SDK **0.3.325**, sem atualização; Claude CLI permanece
  **2.1.325** conforme manifesto anterior. As referências online são mutáveis: não se presume que
  toda funcionalidade ali descrita esteja efetiva no binário fixado.

Hashes locais:

```text
sdk.d.ts  4b7a2ee26e0f6eabf9e94f30d150f4e861c78fea0c78055f33c2b2a833f30935
sdk.mjs   030d9a1a7a629c2716d710f88292545951857612b2056b91affc5a0b073f65bf
```

Na `.runtime/harness/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` da worktree:

| Handle | O que a fonte declara | Limite |
| --- | --- | --- |
| `PostToolBatchHookInput`, linhas 2791–2801 | Depois de todas as ferramentas do lote, antes do próximo request. | Existe na declaração da versão instalada; não foi ensaiado no CLI nesta investigação. |
| `SyncHookJSONOutput`, linhas 10435–10446 | `continue`, `stopReason`, `decision`. | A documentação específica de PostToolBatch diz que `decision: block` ou `continue: false` para antes da próxima chamada. |
| `HookCallbackMatcher`, linhas 1042–1056 | `onFailure: block`; default continue é inseguro como barreira. | Não presumir fail-closed em timeout ou evento com exceções; testar no perfil. |
| `Query.interrupt`, linhas 3027–3037 | Interrupt com receipt opcional, se capability anunciada. | Retorno/ACK não é cessação física; filas podem sobreviver. |
| `SDKControlInterruptResponse`, linhas 5011–5029 | `still_queued`, opcional cancelled, várias ressalvas de cobertura. | Lista vazia não prova ausência de toda atividade ou mensagens sem UUID. |
| `SDKSessionStateChangedMessage`, linhas 6434–6444 | idle/running/requires_action. | Não é contador universal de requests nem prova de cessação guest. |

**Resultado da pesquisa:** há um candidato nativo concreto, `PostToolBatch`, para a transição após
`ask_user`. A afirmação anterior de que só haveria stream era excessiva. Não foi encontrado hook
público universal de início de cada request na lista de eventos da versão instalada; isso não
invalida uma barreira específica de lote com posterior cessação.

O runtime SDK verifica `hook_on_failure_supported` e registro dos hooks ao usar onFailure block,
antes de enviar o primeiro prompt. Um próximo ensaio deve exigir esse suporte, observar o hook real
e testar falha controlada. Não usar hook async (a execução segue sem aguardar), nem retornar
`decision: block` no evento Stop esperando que signifique parar: Stop pode bloquear a parada e
continuar o agente. O evento correto importa.

Há ainda uma divergência de superfície: sdk.mjs aceita internamente `interrupt({cancelQueued:true})`,
mas a assinatura pública `Query.interrupt()` instalada não declara parâmetro. Não usar esse detalhe
interno, protocolo privado ou patch do binário para fundamentar o aceite. Interrupt conhecido mais
cessação física continuam o caminho seguro; nenhuma mudança de versão está proposta.

## Matriz proposta após revisão

| Critério | Proposta atual | Alteração nesta etapa |
| --- | --- | --- |
| C1 | Aprovado | Nenhuma |
| C2 | Aprovado | Nenhuma |
| C3 | **Aprovado local** | Cessação anterior à barreira de revisão já registrada; não é pausa com processo vivo. |
| C4 | Aprovado | Nenhuma |
| C5 | Inconclusivo | Motivo reduzido à falha nativa/auxiliares próprios, sem exigir auditoria global. |
| C6 | Inconclusivo | Motivo preciso: intervalo ACK→cessação e marco de apresentação, não falta de Controle de produção. |
| C7 | Aprovado | Nenhuma |
| C8 | Aprovado | Nenhuma |
| C9 | **Aprovado local** | Comparação independente de registros existentes dentro da fronteira permitida. |
| C10 | Aprovado | Nenhuma |
| C11 | Aprovado | Nenhuma |
| C12 | Inconclusivo | Falta contador de tentativas, não efeito externo real. |

Nove aprovados, três inconclusivos, nenhum reprovado. A proposta anterior permanece preservada com
ponteiro para esta revisão; a spec e o mapa não foram alterados e nenhuma resolução foi registrada.

## Proposta mínima para os três critérios restantes — ainda não autorizada

**Até três ativações Claude Haiku, dez minutos de execução real**, mesmos mecanismos nativos de
assinatura/perfil e sandbox local. Sem Pi adicional, GitHub, AWS, novo adapter ou upgrade.
Preparação e oráculos determinísticos precedem qualquer prompt. Não é autorização de execução.

1. **Pergunta com barreira nativa:** WIP/gate real, pergunta persistida e ACK correlacionados;
   PostToolBatch síncrono identifica ask_user no lote e para a continuação. Confirmar hook efetivo,
   término, ausência de atividade e só então registrar apresentação/espera. O caso Git só é repetido
   como pré-condição técnica do ordenamento corrigido de C6, não para revalidá-lo genericamente.
2. **Retomada com efeito e filtro:** nova admissão após resposta de fixture, contexto explícito e
   efeito e1 incerto. Um dublê local com contador independente mostra tentativas antes/depois;
   calibrar o contador sem modelo com outro efeito de teste. Exercitar falha real de filtro pela
   ferramenta nativa, com erro opaco e sem entrega parcial, e inspecionar transcript/auxiliares
   próprios antes do cleanup. A continuação útil da tarefa impede aprovar por inatividade acidental.
3. **Falha dirigida do hook:** callback de barreira falha deliberadamente com onFailure block;
   confirmar que não ocorre continuação de modelo/tools e cessar fisicamente. Essa é a terceira
   ativação máxima para validar o caminho negativo, não uma reserva de retries automáticos.

Callbacks são JavaScript locais, **não hooks prompt/agent** que fariam inferências extras. Nenhuma
recusa de política será contornada. Se a instalação não confirmar a capacidade, se o hook não
cobrir a transição ou se o oráculo não distinguir request de silêncio, parar e manter o critério
inconclusivo — não relaxar a spec ou atualizar dependências para obter verde.

Antes de pedir orçamento, o desenho desses oráculos pode ser preparado sem modelos. Se a preparação
mostrar que os três casos não cabem nesse limite ou exigem nova permissão, apresentar o motivo em
vez de executar. A campanha encerrada não será reaberta.

## Proveniência e estado

Auditor descartável: branch `prototype/v2-harness-proof`, caminho
`.scratch/software-factory-v2/prototype/acceptance-review.mjs`.
Resultado reproduzível: [observações offline](harness-proof-acceptance-review.json).

A checagem sem modelo passou após corrigir o empate de timestamp; 12 testes determinísticos,
`node --check`, links relativos e `git diff --check` passaram. O auditor confirmou 18 caminhos
auxiliares próprios ausentes e que JSONs anteriores/mapa não foram modificados. LSP consultado:
zero diagnósticos reportados, mas clean inconclusivo por servidor push-only/silent-on-clean; não
se alega typecheck completo. Não há novos recursos nativos para limpar. Branch/worktree existentes ficam preservadas; destino documental original main,
sem integração enquanto resultado/resolução aguardam aprovação. Sem push. Não resolver ticket ou
atualizar mapa a partir desta revisão automaticamente.
