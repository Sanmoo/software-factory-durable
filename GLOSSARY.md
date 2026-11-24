# Software Factory

Fábrica local que transforma tickets autorizados em PRs revisáveis, com agentes, controle durável, validação e merge humano.

Este glossário registra só o vocabulário de produto do [PRD §3](.scratch/software-factory/prd.md) e o identificador inglês que o código usa para cada termo; não cria um modelo de domínio novo nem importa sentidos de outros projetos ([mapa](.scratch/software-factory/map.md)). Para nomes, ele prevalece sobre o código: o código é corrigido.

## control

Dono do ciclo de vida do Trabalho: admissão, filas e Slots, orçamentos, prontidão, reparos, recuperação e cleanup.

**Work** (Trabalho):
Unidade lógica persistente da fábrica, associada a um Ticket e ao seu ciclo de entrega.
_Avoid_: job

**Execution** (Execução):
Uma ativação de Builder para implementar, retomar ou reparar um Work.

**Slot**:
Capacidade para uma Execution ativa de Builder; não inclui esperas externas.
_Avoid_: seat

**Repair** (Reparo):
Execution motivada por conflito, check obrigatório, review humano ou comando autorizado de correção.
_Avoid_: hotfix

**Impediment** (Bloqueio):
Condição explícita que impede avanço e requer informação, autorização ou correção operacional.

**Ready for human review** (Pronto para revisão humana):
PR com reviews dos agentes concluídos, validações atendidas e sem conflito ou Impediment conhecido.

**Delivered** (Entregue):
Work cujo merge foi confirmado no GitHub.

## workers

Dono das sessões de agente que implementam e revisam um Work.

**Builder**:
Agente principal que implementa e decide como tratar os achados dos Reviewers.

**Reviewers** (Revisores):
Subagentes paralelos de Standards e Spec, sem escrita na worktree do Builder.

**Triager** (Triador):
Agente que avalia sozinho um Ticket ainda não especificado e decide seu estado de triagem.

**Triage** (Triagem):
Avaliação de um Ticket pelo Triager, anterior a qualquer Work e distinta de uma Execution.

**Verdict** (Parecer):
Conclusão que o Triager registra para uma Triage, com o desfecho recomendado e sua justificativa.

## sandbox

Dono dos ambientes isolados em que os agentes trabalham.

**Sandbox**:
Ambiente isolado em que um Builder executa código e testes de um Work.

**Investigation Environment** (Ambiente de Investigação):
Ambiente isolado e descartável em que o Triager lê código durante uma Triage; não é um Sandbox e não pertence a um Work.

## issue-tracker

Dono da leitura de tickets e de suas dependências nativas no GitHub.

**Ticket**:
Pedido e referência de especificação em um único repositório, composto pelo corpo e por seus comentários.
