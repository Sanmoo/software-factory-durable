# 16: Aceite da v2 no perfil Lambda

**What to build:** O aceite da v2: os critérios de aceite do MVP (PRD §8, spec §13.2) reexecutados no perfil Lambda com um repositório real, mais os
gates de validação da matriz da spec. É uma campanha em conta AWS real, com modelos reais: exige autorização específica do Operador
(conta, permissões, teto de consumo, prazo e cleanup) e rubrica aprovada antes de rodar, conforme `docs/agents/experiment-proofs.md`.
Homologação de produção é decisão separada do Operador, depois do aceite.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): Seção 11 (matriz de aceite).

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15

**Type:** task

**Status:** ready-for-human

## Acceptance criteria

- [ ] Rubrica por propriedade aprovada pelo Operador antes de consumir orçamento; plano com teto de consumo e cleanup.
- [ ] Critérios de aceite do MVP reexecutados no perfil Lambda com um repositório real.
- [ ] V2-03, V2-04: repositório que exige capacidade ausente recebe diagnóstico.
- [ ] V2-05 a V2-07: gate recusando com agente real; três recusas geram Bloqueio.
- [ ] V2-09: espera humana e de CI encerram a MicroVM antes de liberar o Slot.
- [ ] V2-10, V2-11: mesma sessão após troca; retomada com commits de terceiros.
- [ ] V2-12, V2-13: troca sob margem real; chamada interrompida na metade da margem; boot acima de uma hora.
- [ ] V2-14: dois boots sem commit novo geram Bloqueio.
- [ ] V2-15 (obrigatório): nenhum pedido de modelo nem chamada depois da cessação confirmada.
- [ ] V2-16: ref de marcador criada, informada à substituta e removida no cleanup.
- [ ] V2-17 a V2-19 (obrigatório): substituta conclui, publica e pergunta sobre o efeito incerto.
- [ ] V2-20 a V2-22: canal caído com reconexão, órfão encerrado e resultado indeterminado.
- [ ] V2-23: revisores reais do harness no Lambda.
- [ ] V2-24, V2-25: token não persiste no guest; guest sem credenciais AWS.
- [ ] V2-27, V2-28: ambiente declarado de um repositório real; causa da falha de build visível.
- [ ] V2-30, V2-31: `validate` com quota excedida e com permissão faltante.
- [ ] V2-32 a V2-34: consumo por boot e por Trabalho; reconciliação encerra órfãs por tag.
- [ ] Resultados registrados com o que ficou não coberto (coluna "Não coberto" da matriz), sem promover a provado o que não foi observado; recursos removidos e cleanup confirmado.
