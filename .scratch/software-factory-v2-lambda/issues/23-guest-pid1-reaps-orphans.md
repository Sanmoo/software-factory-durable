# 23: O processo 1 do guest recolhe filhos órfãos

**What to build:** O processo 1 do guest (`hook-agent.py`) não recolhe filhos órfãos: processos encerrados ficam como zumbis até o fim do boot. Foi a causa de fundo do A11 (zumbi tido como chamada viva), contornado conferindo o estado do processo. Fazer o processo 1 recolher os filhos, ou usar um init mínimo.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** migrado para [#28](https://github.com/Sanmoo/software-factory-durable/issues/28) em 2026-11-22; a issue é a versão canônica.
## Observed

- Sonda da janela 8: vários processos `timeout` e `sleep` órfãos sob o processo 1 depois da varredura.
- Diagnóstico do A11 em contêiner local com a imagem real: a chamada órfã morta virava zumbi e `kill -0` respondia vivo.
- Evidência: `probes/g24-run3.txt` (tabela de processos); registro corrido, janelas 5 e 8.

## Why it matters

Zumbis acumulam em boots longos (até 4500 s) e qualquer verificação de vivacidade por sinal volta a errar.

## Acceptance criteria

- [ ] Depois de uma chamada encerrada pelo host, não resta processo zumbi dela no guest (teste com a imagem do guest).
- [ ] A verificação de vivacidade do fim de chamada continua correta com e sem zumbis.
- [ ] Mudança no guest gera novo hash dos assets e release nova, como previsto no plano.
