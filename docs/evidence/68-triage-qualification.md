# Qualificação real da Triagem (`triage-qualification`): receita preparada, não executada

Spec [#68](https://github.com/Sanmoo/software-factory-durable/issues/68) §13, ticket #84. Oráculos: TQ-01 a TQ-06 e TR-43.

**A receita não foi executada contra nada real.** Nenhum modelo foi chamado, nenhum repositório, issue, label ou Card foi criado ou
escrito, nenhuma credencial real foi usada e nenhuma VM foi iniciada. O que existe é a receita, o corpus, a rubrica, a matriz e os
testes offline das regras. Toda linha da [matriz](68-triage-qualification-matrix.json) está `inconclusiva` e assim fica até uma execução
autorizada pelo operador. Um teste offline verde prova que a receita julga um resultado salvo como a spec pede, nunca que a Triagem
foi qualificada.

## O que há

| Arquivo                                                                    | Papel                                                                                        |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `test/entrypoints/triage-qualification.ts`                                 | A receita: fases, guardas, composição de produção, veredito por critério                     |
| `test/entrypoints/triage-qualification-corpus.ts`                          | Nove Tickets (dois por desfecho e um hostil) e três Cards, com desfecho esperado e proibidos |
| `test/entrypoints/fixtures/triage-qualification/repository/`               | Conteúdo do repositório fixture: a verdade de base do corpus                                 |
| `scripts/agent-checks/triage-qualification.mjs`                            | Lançador: lê a rubrica aprovada e entrega o helper de finalização                            |
| [68-triage-qualification-rubric.json](68-triage-qualification-rubric.json) | Rubrica por propriedade, no formato de `docs/agents/experiment-proofs.md`                    |
| [68-triage-qualification-matrix.json](68-triage-qualification-matrix.json) | Matriz TQ-01 a TQ-06, verificada por `test/entrypoints/triage-qualification-matrix.test.ts`  |

## Desenho

- **Composição.** Cada passagem usa a composição de produção como `controller/owner.ts` a faz: `readConfiguration` de um `config.yaml`
  schema 3, `composeProductionAccess`, `composeProductionTriage`. O Triager é o agente de produção, numa unit do systemd de usuário
  por tentativa, com o perfil OAuth da release e raciocínio `max`; a publicação é a real.
- **Duas passagens, cada uma sobre a sua cópia do corpus.** `measure` roda com limites folgados (144 requisições, 480 chamadas, 45
  minutos). Os valores definitivos são o maior consumo de um pedido concluído vezes 1,5, arredondado para cima: requisições e chamadas
  por tentativa, minutos por pedido. `fixed` roda sob esses valores e é a que vale. Como o `triager-v1` é fixo na release, cada
  passagem roda num build cujo `triagerBudgetV1` é o orçamento daquela passagem; a receita recusa outro build antes de qualquer efeito.
- **Termina no Work admitido.** Nenhum Builder, reviewer ou Sandbox real roda. O Sandbox e os workers das portas de execução são
  substituídos por uma testemunha que grava o primeiro prompt entregue ao Builder e não inicia nada. O ambiente, o boot e o commit
  base citados nesse prompt são valores de dublê, não evidência.
- **Aprovação.** Zero desfecho proibido no corpus inteiro e o esperado em sete dos oito Tickets não hostis, na execução única de
  `fixed`. Sem tenant Jira autorizado, os critérios Jira ficam inconclusivos, nunca aprovados.
- **Uma só vez.** Um tombstone de intenção exclusivo precede cada efeito; fase consumida não roda de novo; nada é repetido.

## Onde cada pendência das fatias anteriores é observada

| Origem  | O que ficou para a qualificação real                                                                                       | Critério             | Onde                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| #78     | Marca do pedido em `historyMetadata` devolvida no changelog; forma do item de componente; linhas de comentário inalteradas | `TQ-05-jira`         | `fixed` e `inspect`: changelog e comentário de cada Card publicado, lidos pelo adapter de produção           |
| #78     | O limite de 32.767 conta caracteres de texto                                                                               | `jira-comment-limit` | `jira-probe`: comentário de 32.767 caracteres aceito, de 32.768 recusado, primeiro lido de volta             |
| #77     | Label confirmada por leitura, fechamento `not_planned`, autoria nos eventos da timeline                                    | `TQ-05-github`       | `fixed` e `inspect`: cada issue publicada lida de volta                                                      |
| #75     | Perfil OAuth de produção sob o diretório de perfil do Triager nunca executado                                              | `oauth-profile`      | `measure` e `fixed`: toda tentativa usa esse perfil                                                          |
| #79     | Nenhuma unit real do systemd com servidor MCP configurado                                                                  | `mcp-in-unit`        | `measure` e `fixed`: Perfil MCP ativo sobre uma fonte Streamable HTTP local da receita                       |
| #72/#76 | Pico de memória, processos e duração de comando contra os limites                                                          | `TQ-04`              | `measure` e `fixed`: amostras somente leitura da unit de cada tentativa e contagem de timeouts no transcript |

## O que o operador fornece e autoriza

1. **Autorização desta execução**, separada de qualquer outra: consumo de modelo de duas passagens de doze Triagens com raciocínio
   `max`, as escritas do GitHub App no repositório fixture, as escritas da conta Jira (se houver tenant) e a limpeza.
2. **Revisão da rubrica** e o registro em `docs/evidence/68-triage-qualification-rubric.approval.json`
   (`{ "rubricSha256": "<64 hex>", "approvedBy": "<registro da revisão>" }`). É registro de revisão, não autorização de gasto.
3. **Raiz de instalação própria da qualificação** (`/home/sanmoo/software-factory-test/t68`), privada, sem `config.yaml`, com o primeiro
   login OAuth do operador, `credentials/app.pem` e, com tenant, `credentials/jira-token`.
4. **Repositório fixture no GitHub**, vazio, com o App instalado e `Issues: write`. O supervisor roda uma vez o script que a receita
   imprime em `--plan` (`setup`), que publica o conteúdo, cria as labels e as dezoito issues sem `needs-triage`, e fixa em commit
   revisado o repositório, os IDs, o commit e os números em `fixture`.
5. **Tenant Jira Cloud (opcional).** Projeto cuja conta tenha `BROWSE_PROJECTS`, `ADD_COMMENTS` e `EDIT_ISSUES`, um componente roteado
   para o repositório fixture, seis Cards do corpus e um Card de sonda, fixados em `tenant`. Sem isso a parte Jira fica inconclusiva.
6. **Host Linux** com systemd de usuário, namespaces sem privilégio, `bwrap`, `git` e `rg`.
7. **Dois builds da revisão sob teste**: `triagerBudgetV1` em 144/480 para `measure`; depois, com os valores definitivos fixados em
   `fixedLimits` e em `triagerBudgetV1`, para `fixed`.
8. **O ato humano de cada passagem**: aplicar `needs-triage` nos Tickets e Cards daquela passagem (a receita grava o script e espera).

## Como rodar, depois de autorizado

```sh
node scripts/agent-checks/triage-qualification.mjs --plan
node scripts/agent-checks/triage-qualification.mjs preflight
node scripts/agent-checks/triage-qualification.mjs measure
node scripts/agent-checks/triage-qualification.mjs fixed
node scripts/agent-checks/triage-qualification.mjs jira-probe
node scripts/agent-checks/triage-qualification.mjs inspect
```

`preflight` só lê. `jira-probe` existe apenas com tenant e é a única fase em que a própria receita escreve num tracker (dois
comentários no Card de sonda). `inspect` lê as origens de volta, avalia cada critério pelo helper `finalizeProof` e não remove nada.

## Limites conhecidos

- A duração de cada comando não é registrada pelo produto: a testemunha de `commandSeconds` é a contagem de
  `INVESTIGATION_COMMAND_TIMEOUT` em cada transcript.
- Requisições de modelo por tentativa são as entradas de uso da sessão: requisição encerrada sem resposta não conta.
- A regra de precedência é texto da skill `implement` que o primeiro prompt inicia, não do próprio prompt. Como nenhum Builder real
  roda, a obediência à regra não é observada.
- Os caminhos com efeito real da receita passam pelo typecheck e nunca foram executados; um defeito neles só aparece na execução
  autorizada. A receita é de uso único por fase: um defeito consome a fase.
