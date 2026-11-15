# 17: Confirmar entrega e limpar somente recursos próprios

**What to build:** Quando uma pessoa faz merge do PR próprio, a Factory confirma a entrega e remove apenas os recursos daquele Trabalho que podem ser limpos com segurança. Cleanup falho continua operável sem desfazer o resultado entregue.

**Blocked by:** [14: Publicar e reconhecer o PR draft próprio](14-direct-draft-publication-and-discovery.md)

**Status:** resolved

## Acceptance criteria

- [x] Entrega exige merge confirmado por identidade do PR/ciclo, não fechamento de issue/PR ou texto do Builder; merge durante cancelamento continua sendo entrega e impede novas ações do agente.
- [x] Cleanup automático só começa após merge e cessação confirmados e preservação da evidência necessária fora do ambiente removido.
- [x] Plano e intenção/resultado por recurso identificam worktree/checkout, branches local/remota, temporários e ambiente próprios; base, desconhecidos e outros Trabalhos são protegidos, sem Docker global.
- [x] Branch remota usa concessão de cleanup própria e precondições de ownership/concorrência, sem ampliar token normal de acompanhamento.
- [x] Resultados distinguem removido, ausência comprovada, falha parcial e indeterminado; consulta falha não comprova ausência, e sucesso de um recurso não encerra os outros.
- [x] Repetição só seleciona pendentes após revalidação, preservando refs/histórico/reviews/decisões e registros protegidos necessários; não espera retenção de detalhes para limpar recursos entregues.
- [x] CLI explica entrega e pendências de cleanup separadamente; integração real inclui merge humano autorizado, falha parcial e retry sem atingir recurso alheio.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 8, 12.1, 12.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-04, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-15.

**Entrega.** A entrega é o merge humano confirmado do PR próprio vinculado pelo ticket 14. Ele é lido por `readOwnMerge`, uma leitura `delivery-read` de um GET.
- Conferem: id/node do PR, branch própria do registro do Controle, repositório, base com id, `merged_at` no PR fechado e head entre os `linkedHeads` publicados pela Factory.
- Fechamento sem merge, issue fechada, outra identidade, head de terceiro e texto do Builder nunca entregam.
- Um commit grava: Work `delivered`, a memória mínima (`ticketIndex.memory`: `delivered`, `mergeConfirmed: true`, consumida pela avaliação de dependências do ticket 08) e a saída da fila. A readmissão do Ticket devolve `existing`.
- Um merge durante uma atividade interrompe essa atividade: credenciais retiradas, boot próprio parado, Slot liberado só após cessação.
- Nada novo é ativado depois da entrega. O cancelamento ainda não existe (ticket 25); o subcaso "merge durante cancelamento" está coberto como merge durante atividade, e o ticket 25 deve manter a entrega prevalecendo.

**Cleanup.** Separado e explicado à parte na CLI, nunca desfaz a entrega.
- Só começa após merge e cessação confirmados, e com a evidência preservada primeiro (captures de revisão e versões de spec/instruções em `<root>/<work>/evidence/<id>/`, manifesto com sha256).
- Remove apenas os recursos próprios: o ambiente via `Sandbox.remove` (disco, checkout e branch local, temporários) e a branch remota própria. A branch remota é apagada por uma deleção atômica condicional (`updateRefs` com `beforeOid`), sob uma concessão `branch-cleanup` própria e de uso único, depois de checar PR merged, ausência de PR aberto com a branch como head ou base, e que não é base/default.
- Protegidos: base, cache compartilhado, outros Trabalhos, Docker e histórico.
- Há intenção e resultado por recurso. `removed`/`absent`/`failed`/`indeterminate`/`refused`/`kept` são distintos. Só pendentes retentáveis são repetidos (no boot e diariamente); `refused`/`kept` aguardam decisão do operador.

**Ensaio real `q17-delivery-v4`.**
- Preflight: cópia do storage do 14 v8 migrada 1→2, digest `74b96fb5…` idêntico.
- O ticket 16 converteu o PR #5 para ready. O operador aprovou e fez merge (merge commit `eb6178d…`). Para fazer o merge sem bypass, ele removeu a regra `update` do ruleset; isso virou o achado do ticket 39.
- `deliver`: entrega confirmada (head `bfdd439`); 19 arquivos de evidência preservados; ambiente próprio removido; branch remota com falha provocada (pendente), entrega mantida.
- `retry`: a varredura de boot apagou somente `refs/heads/factory/3-99fe871b`, com deleção atômica disponível ao token da App e grant revogado.
- `inspect`: PR merged; refs: só a branch própria sumiu, e a `main` só mudou pelo merge humano; os outros 22 ambientes, o cache e o Work #6 ficaram inalterados.
- Gate `test:ci`.
- Evidência: `docs/evidence/17-confirmed-delivery-and-owned-cleanup.md` e `docs/evidence/17-real-delivery-v4-*.json`.

