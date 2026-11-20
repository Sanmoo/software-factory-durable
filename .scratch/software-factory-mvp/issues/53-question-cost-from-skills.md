# 53: Menos Perguntas evitáveis: seams descritos no Ticket e comentários que mudam `updatedAt`

**What to build:** no piloto 35 o operador respondeu 14 Perguntas reais em 3 Tickets (#124: 3, #125: 5, #126: 6). Só 3 eram decisões do
próprio Ticket ou do desenho: a regra do restante da captura parcial do #125 (2, uma por ciclo) e a aprovação do desenho do evento V2 pedida
pela revisão Spec do #125 (1). O resto:

- **Seams do TDD (6):** a skill `tdd`/`implement` exige aprovação explícita dos seams públicos antes dos testes. Todo Ticket perguntou, mesmo
  quando o corpo nomeava as camadas e os estilos de teste (domínio, use case com portas falsas, IT Postgres, REST, Cucumber); o #126 perguntou 4
  vezes (recovery e ciclos novos repetiram depois de resposta já dada).
- **`updatedAt` do issue (1, #126):** o Builder viu `updatedAt` mudar e perguntou se o escopo tinha mudado; a mudança vinha dos próprios
  comentários de Pergunta e resposta.
- **Ambiente (2):** falta de JDK no guest (ticket 44); no #124 a orientação já foi dada junto da resposta de seams.
- **Revisão incompleta falsa (2, #124):** ticket 51.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Skill: quando o Ticket nomeia as camadas/estilos de teste, os seams correspondentes à arquitetura existente do repositório contam como
  aprovados; a Pergunta fica para seams novos ou ambíguos. Nova versão do pacote de skills.
- [x] Respostas a Perguntas de seam já dadas no Trabalho chegam às Execuções seguintes (preservadas como fonte) e não geram nova Pergunta.
  O ticket 48 já passa as Perguntas respondidas no resumo de continuação/recovery; aqui só se confirma (teste) que isso cobre os seams e que a
  skill manda usá-las.
- [x] A verificação de mudança do Ticket compara título/corpo preservados, não `updatedAt`; comentários não contam como mudança de escopo.

## Answer

Resolvido em 2026-11-19 (branch `fix/53-fewer-questions`, sobre `6cd3184`). A medição de Perguntas por origem fica no [54](54-pilot-2.md).

**Pacote `factory-skills-v9` (9.0.0)** = v8 mais (v1–v8 inalterados; a release compõe o último pacote com `continuation`, agora o v9):

- `tdd` ("Seams"): um seam é acordado por (1) **o Ticket nomeia e o repositório tem**: o Ticket ou documento que ele referencia nomeia a
  interface/seams, ou as camadas/estilos de teste (domínio, use case com portas falsas, IT Postgres, REST, Cucumber), e os seams
  correspondentes já existem na arquitetura do repositório ("Those seams count as approved: do not ask about them"); ou (2) **resposta já
  dada no Trabalho** (resposta aceita do `continue`/recovery, resposta anterior na sessão ou `answered-questions` do resumo do 48: "never
  ask that question again, not even reworded"). "Ask ONLY for seams that are new [...] or ambiguous", nomeando só esses e listando os já
  acordados com a fonte. `implement` §2 aponta para essa regra.
- `implement` §4.5 (nova) e §5.2: toda Pergunta já respondida no Trabalho está decidida (resposta aceita e cada `answered-questions` do
  "Factory state summary"); usar e nunca perguntar de novo.
- `implement` §6: "**Has the Ticket changed?** Compare only its current `title` and `body` with those of `ticket.json` in the latest complete
  preserved version, never `updatedAt` or another timestamp [...]. Comments [...] are never a scope change"; título/corpo iguais não são
  mudança. §1.2 deixou de buscar `updatedAt` (`gh issue view <link> --json number,title,body,url,author,labels`) e `revision` do Ticket é `null`.

**Onde estava o `updatedAt`.** Só no pacote: `implement` §1.2 buscava `updatedAt` e §1.5 o gravava como `revision`; em recovery/nova versão o
Builder comparava com o Ticket atual. No Control nada compara o Ticket por tempo: `issueSchema` (`src/issue-tracker/index.ts`) nem lê
`updated_at`/título/corpo do issue; o `updatedAt` de comentários só serve à regra de comentário editado (`commentEligibility`/`commentCommand`).
Teste de regressão: `readTicket` é a mesma observação quando só comentários mudaram o issue.

**Procedimento de nova versão (repetível pelo 44).** 1) `cp -r assets/skill-pack/factory-skills-v9 assets/skill-pack/factory-skills-v10`;
2) trocar `factory-skills-v9` por `-v10` nos `prompts/*.md` e no título do `CREDITS.md`; 3) editar as skills; 4) acrescentar a linha da
versão no `CREDITS.md`; 5) no `manifest.json` trocar `id`, `version`, `guestDirectory` e recalcular o `sha256` de cada arquivo (python:
`hashlib.sha256(Path(f['path']).read_bytes())`, `json.dumps(m, indent=2, ensure_ascii=False) + '\n'`); 6) acrescentar o id em
`factorySkillPackIds` (`src/contracts/index.ts`) e a linha no comentário de `src/workers/skill-pack.ts`; 7) teste
`test/workers/skill-pack-v10.test.ts` (hashes, regras novas e herdadas, caminhos de guest, `continuation`, CREDITS, versão anterior intacta)
e, se o teste citar o `timeout: 1800` herdado, isenção em `test/runner/fixed-timers.test.ts`. Release, composição, inventário e upgrade derivam
de `factorySkillPackIds` (`latestContinuationPack`), sem pin manual.

**Testes.** `test/workers/skill-pack-v9.test.ts` (4: seams, respostas dadas, mudança por título/corpo e ausência de `updatedAt`, herança e v8
intacto); `test/control/continuation48-flow.test.ts` +2 (Control + Pi Durable/SQLite reais: duas Perguntas de seam respondidas em Execuções
anteriores chegam com as respostas à nova sessão de uma continuação após fim de orçamento e de uma recovery operacional comum);
`test/entrypoints/github-admission-reads.test.ts` +1 (adaptador real: `readTicket` sem timestamp); mais os dois testes de fluxo abaixo.

**Respostas em toda nova sessão (Control).** Além da continuação de orçamento e da recovery operacional (48), o resumo com TODAS as Perguntas
respondidas do Trabalho (mesmo bloco limitado `answered-questions` de `stateSummary`) entra agora também (a) na retomada após resposta em
sessão substituta (`recoveryPrompt`, campo `summary`, nunca descartado pelo limite de tamanho; ex. `SESSION_LOST`/`SESSION_NOT_RECORDED`), junto
da resposta atual, e (b) na continuação após parada administrativa (`ADMINISTRATIVE_STOP`, sempre). `answeredOf`/`workSummary` em
`src/control/durable/dispatch.ts`. Testes de fluxo: `continuation48-flow.test.ts` (sessão substituta com duas Perguntas de seam) e
`recovery-flow.test.ts` (parada administrativa com Pergunta respondida antes).

**Limites.** A não-repetição depende do prompt/skill; o Control não recusa uma Pergunta repetida. Um `continue` na MESMA sessão leva só a
resposta atual (as anteriores estão na própria conversa). Um ciclo novo (Trabalho novo) não herda respostas (fora do escopo). Prova real no
[54](54-pilot-2.md).

## Comments

- Evidência: comentários `/factory answer` nos issues #124–#126 de `Sanmoo/java-springboot-event-sourcing`; `pl1-pilot-evidence/findings.md` item 7.
- Relacionados: [44](44-per-project-guest-environment.md), [48](48-builder-budget-continuation.md).
- 2026-11-19 triagem (operador): critérios mantidos; nova versão do pacote de skills (v9); a medição de Perguntas por origem foi para o
  [54](54-pilot-2.md); entra antes do 44.
