# 14: Publicar e reconhecer o PR draft próprio

**What to build:** Depois da implementação/revisão, o Builder publica sua branch e abre o PR draft com descrição curta. A Factory reconhece a publicação própria e recupera resultado incerto antes de repetir push ou criação.

**Blocked by:** [13: Tratar achados e comprovar gates sobre o conteúdo atual](13-findings-treatment-and-current-content-gates.md)

**Status:** resolved

## Acceptance criteria

- [x] Builder usa pr para redigir e publica diretamente por Git/API usando App restrita ao repo; controlador não faz push por gateway e não presume que carregar a skill publicou.
- [x] Associação Trabalho/Ticket/repo/branch/base/PR é inequívoca e preserva identidades; PR abre draft após reviews aplicáveis, sem encerrar Ticket pela simples abertura.
- [x] Descrição resume mudança/razão/vínculo, validação/limitações/dispensas e risco humano; detalhes protegidos ficam separados, sem transcrição integral nem caminho local apresentado como link remoto útil.
- [x] Ausência de PR conhecido leva a solicitação de publicação ao Builder; branch com nome esperado não prova autoria e PR desconhecido não é adotado.
- [x] Registros normais preservam refs e evidências recuperáveis usadas, sem exigir intenção/ACK extra, wrapper Git/gh ou parser de shell por push/criação.
- [x] Após cessação e resultado perdido, observação Git local/remoto/PR encontra publicação correlacionada antes de repetir; múltiplos candidatos, leitura incompleta ou mudança desconhecida bloqueiam repetição insegura.
- [x] Integração com agente e GitHub reais demonstra draft próprio, identidade, descrição e descoberta de publicação incerta, sem merge/aprovação humana pelo agente.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.1, 8, 9.1; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-09, V-12 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-15: depois da verificação de fim de Execução (ticket 13) sobre conteúdo commitado, o Controle descobre a publicação própria (ref da branch própria, todas as refs, proteção da base sem bypass da App e PRs correlacionados por marcador + bot da App fixado + branch/repo/base próprios) e, só em ausência completa nunca tentada, solicita UMA ativação publish-only do Builder (grant `builder-publish` Contents W + PR W do próprio repo, sessão nova sem handoff/edit, lease explícito); o Builder publica direto por Git/`gh`, sem gateway/wrapper/parser. A tentativa é durável no commit de ativação; após cessação só a descoberta decide: PR próprio é vinculado (abertura não encerra o Ticket), múltiplos candidatos/PR desconhecido/mudança desconhecida de refs/leitura incompleta bloqueiam ou retêm, e push observado sem PR permite uma única continuação só-PR. Pacote `factory-skills-v6` (v5 + publicação). Gate `test:ci` verde; ensaios reais: v6 (push ok, `gh` sem PATH → bloqueio fail-closed; corrigido o PATH exportado), v7 (revisão incompleta por caminho inexistente → `not-publishable`; corrigido `READ_NOT_FOUND`), v8 publicou o PR draft #5 em `bfdd439` e o descobriu após reinício do dono (AC6 também evidenciado no v6). Evidência: `docs/evidence/14-direct-draft-publication-and-discovery.md`.
