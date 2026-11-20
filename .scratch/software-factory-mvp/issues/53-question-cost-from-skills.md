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

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Skill: quando o Ticket nomeia as camadas/estilos de teste, os seams correspondentes à arquitetura existente do repositório contam como
  aprovados; a Pergunta fica para seams novos ou ambíguos. Nova versão do pacote de skills.
- [ ] Respostas a Perguntas de seam já dadas no Trabalho chegam às Execuções seguintes (preservadas como fonte) e não geram nova Pergunta.
  O ticket 48 já passa as Perguntas respondidas no resumo de continuação/recovery; aqui só se confirma (teste) que isso cobre os seams e que a
  skill manda usá-las.
- [ ] A verificação de mudança do Ticket compara título/corpo preservados, não `updatedAt`; comentários não contam como mudança de escopo.

## Comments

- Evidência: comentários `/factory answer` nos issues #124–#126 de `Sanmoo/java-springboot-event-sourcing`; `pl1-pilot-evidence/findings.md` item 7.
- Relacionados: [44](44-per-project-guest-environment.md), [48](48-builder-budget-continuation.md).
- 2026-11-19 triagem (operador): critérios mantidos; nova versão do pacote de skills (v9); a medição de Perguntas por origem foi para o
  [54](54-pilot-2.md); entra antes do 44.
