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
- [ ] V2-05 a V2-07: gate recusando com agente real; três recusas encerram o boot como perda e a substituta retoma pela fila. (Decisão do Operador em 2026-11-21; antes: "três recusas geram Bloqueio".)
- [ ] V2-09: espera humana e de CI encerram a MicroVM antes de liberar o Slot.
- [ ] V2-10, V2-11: mesma sessão após troca; retomada com commits de terceiros; histórico reescrito segue o remoto com sessão substituta e branch ausente abre Pergunta. (Os dois últimos: decisão do Operador em 2026-11-21.)
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

## Answer

A campanha rodou em 2026-11-21 e 2026-11-22 na conta autorizada pelo Operador, com a rubrica v1 aprovada antes do primeiro
boot, sete releases construídas da `main` (v2-acc-1 a v2-acc-7), o repositório real `Sanmoo/java-springboot-event-sourcing`
e o repositório de apoio `Sanmoo/sfv2acc-fixture`. Relatório: `lambda-acceptance-results.md`; avaliação por critério:
`lambda-acceptance-assessment.json`; registro corrido: `lambda-acceptance-findings.md`.

**Resultado.** Dos 31 critérios: 21 `approved`, 10 `inconclusive` (9 parciais, 1 não tentado), nenhum `rejected`. Os dois obrigatórios estão `approved`: V2-15 (depois da cessação confirmada não houve pedido de
modelo nem chamada) e V2-17 a V2-19 (a substituta concluiu, publicou, não repetiu o efeito incerto e perguntou sobre
ele). Não é homologação de produção, que continua sendo decisão separada do Operador.

**Provado no perfil Lambda.**

- Jornada completa de um Ticket até o merge humano e a limpeza; dois Builders simultâneos com Testcontainers; dependência nativa; reparos por conflito e por check obrigatório; commit humano preservado até o PR.
- V2-05 a V2-07: o gate recusa com agente real; três recusas encerram o boot como perda e a substituta retoma pela fila.
- V2-09: espera humana e de CI encerram a MicroVM antes de liberar o Slot.
- V2-10: mesma sessão depois da troca de boot. V2-12 e V2-13: troca sob margem real, chamada interrompida na metade da margem e boot de 4150 s. V2-14: dois boots sem commit novo geram Bloqueio.
- V2-16: ref de marcador criada, informada à substituta e removida na limpeza do Trabalho.
- V2-20 a V2-22: canal caído com reconexão, órfã encerrada e resultado indeterminado; canal irrecuperável leva a boot novo.
- V2-23 a V2-25: revisores reais sem escrita e sem Docker; nenhum token em arquivo e nenhuma credencial AWS no guest (resíduo já aceito: o token no ambiente do processo residente do marcador).
- V2-27 e V2-28: ambiente declarado de um repositório real e causa da falha de build visível.

**Não provado por inteiro (`inconclusive`).**

- C05 (CA-05): Slot liberado e retomada vistos; faltou outro Trabalho iniciado durante a espera.
- C07 (CA-07): faltou confirmar a branch na origem depois de um cancelamento.
- C10 (CA-10): faltou o rótulo retirado de um Ticket ainda na fila.
- C12 (CA-12): a maioria dos Bloqueios tem causa e próximo passo; quatro casos não tinham (A9, A12, A15, A17).
- G11 (V2-11): histórico reescrito e branch ausente vistos; o commit de terceiro foi incorporado, mas não na mesma sessão.
- G30 (V2-30, V2-31): quota e permissão acusadas pelo nome; dois checks do Lambda saem `unverified` por desenho.
- G32 (V2-32 a V2-34): consumo por boot e por Trabalho confere com o serviço; a reconciliação não é por tag da MicroVM (o serviço não aceita) e não houve declaração explícita de evidência do guest perdida.
- X0: perfil registrado sem as versões de `aws-cli`, `ssh` e `websocat`.
- X2: limpeza feita em parte; restam os itens do Operador listados abaixo.
- G30b: espera por falta de capacidade não foi tentada.

**Não coberto.**

- V2-04 (capacidade ausente): não é observável em conta real; fica com os testes compostos.
- CA-03 com três Builders; CA-02 com dados inacessíveis; CA-05 com conta não autorizada; CA-07 com falha de limpeza; CA-12 com revisão indisponível; CA-06 nos cortes exatos depois de push, PR e Pergunta.
- Push lento; hook com remoto indisponível; conexão além de 38 minutos com medição; oito horas e carga sustentada; sessões longas e compactação.
- x86_64, outras regiões e tamanhos, VPC; cache entre boots; limite de pulls do Docker Hub.
- Log do lado do provedor do modelo; variância do modelo além de uma execução; efeitos em serviços reais.
- Cobrança da AWS (acima do baseline e por tag): não foi lida.
- A9 parte B (substituta automática para falha não transitória): tem teste automatizado, não foi exercitada na conta.
- Nova tentativa depois de build falho com a correção A18.
- Canal bloqueado além do limite depois da correção A11; órfã conhecida só por tag.

**Achados.** Doze resolvidos e verificados na conta: A1 a A8, A9 parte A, A11, A13 e A14 (o A4 por decisão do Operador,
sem mudança no produto). A `main` está nas quatro correções A13, A14, A6 e A9 parte B (release v2-acc-7). A A18 (a limpeza de
imagens falhava na última versão de cada imagem) foi corrigida e verificada na conta com a release local v2-acc-8, mas ainda
não está na `main`: `npm run test:ci` falhou quatro vezes por causa ambiental (cota do `/tmp`), nunca no código alterado.
Viram tickets: A10, A12, A15, A16, A17, A19 e quatro candidatos de acompanhamento (tickets 17 a 26).
O Ticket #10 do repositório de apoio teve o `update-scope` executado a pedido do Operador e publicou o PR #36; o reparo
automático do conflito se perdeu (A17), o Trabalho foi cancelado e o PR #36 não foi entregue.

**Custo.** 51 MicroVMs, 8,34 MicroVM-horas (teto 40), pico de 2 simultâneas, 3 builds de imagem (teto 30), 33,0 M tokens
(teto 150 M), estimativa do catálogo do SDK US$ 2,31 (estimativa, não fatura; a cobrança da AWS não foi lida). Estado
final: 23 Trabalhos, 13 entregues, 9 cancelados, 1 fechado sem merge, nenhum aberto.

**Limpeza.** Feito e verificado: nenhuma MicroVM viva, nenhuma imagem, bucket de build vazio, log groups de build ausentes,
repositório de apoio apagado, repositório real sem PR aberto nem refs da Factory e com o ruleset igual ao anterior. Duas das
três imagens saíram pela CLI da AWS, não pelo produto (A18 e A19). **Pendente do Operador:** apagar a stack `factory-sfv2acc`
(roles e o bucket vazio), o usuário IAM `factory-sfv2acc-operator` e sua chave, os perfis AWS locais `factory-sfv2acc` e
`factory-sfv2acc-source`, e `lb1/credentials`. Por isso o critério X2 ficou `inconclusive` (parcial).
