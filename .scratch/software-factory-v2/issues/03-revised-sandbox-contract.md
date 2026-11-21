# Consolidar o PRD e a spec da v2 para o sandbox Lambda MicroVMs

Status: resolved
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — ambientes reconstruíveis em Lambda MicroVMs](../map.md)
Blocked by: 02, 09

## Question

Como consolidar a direção de [sandbox](01-lambda-microvms-direction.md#answer) e os resultados da
[prova Lambda](02-lambda-microvms-prototype.md) em requisitos e contratos implementáveis da v2,
mantendo o harness do MVP e preservando a autoridade e o escopo do MVP?

## Scope

- Trabalhar sobre as evidências da prova Lambda, sem presumir êxito nem suporte oficial
  Docker/SSH. Hipótese
  que falhou/inconclusiva exige decisão do operador, não substituição silenciosa de escopo.
- Propor revisão versionada do PRD/spec na feature v2, rastreando diferenças frente ao
  [PRD](../../software-factory/prd.md), à [spec](../../software-factory/spec.md) e às
  [interfaces públicas](../../software-factory/module-public-interfaces.md) do MVP.
- Definir contrato mínimo versus capacidades por adapter e exigências por repositório, sem exigir
  VFS/mount no host, disco permanente ou boot ilimitado. Configuração específica fica encapsulada.
- Precisar preservação Git antes de qualquer espera humana e troca de boot: branch/commit remoto,
  gate verificável, falha de push, alterações humanas concorrentes e publicação de WIP sem segredos.
  Workspace sujo, stash e remoto não confirmado nunca equivalem a preservação concluída.
- Distinguir revisão interna no mesmo boot, espera humana, espera de CI, perda e reconstrução;
  decidir detalhes ainda não aprovados sem importar checkpoint em todo handoff.
- Definir margem de rotação, chamadas longas, cessação, identidade/geração, reconciliação de efeitos,
  continuidade compatível versus sessão substituta e limites/budgets sem loops infinitos.
- Incorporar transporte validado, restrição técnica dos revisores, proteção das credenciais e a
  fronteira confiável dos componentes. Autenticação do túnel não é autorização de todas as operações.
- Explicitar propriedades de egress demonstradas e relaxamentos frente ao MVP que precisem de
  confirmação; não equiparar internet pública automaticamente a mediação/isolamento comprovados.
- Definir instalação, observabilidade, quotas/custos, retenção/cleanup e matriz de aceite.
  Distinguir evidência da prova e gates de validação futura. Seleção automática de sandbox,
  Slots por adapter e política híbrida não estão autorizados.

## Exit criteria

Decisões aprovadas pelo operador e documento da v2 rastreável, sem lacunas preenchidas por suposição,
com contratos e critérios de aceite sustentados pelas provas disponíveis. O mapa só pode encerrar
quando suas lacunas de desenho estiverem resolvidas; se necessário, abrir filhos específicos.
Não implementar o adapter nem alterar retroativamente o PRD/spec aprovado do MVP neste ticket.

## Answer

Aprovado pelo Operador em 2026-11-21. O documento é a [spec da v2](../spec.md): só as diferenças frente
ao MVP, com requisitos V2-01 a V2-34 marcados como provados, decididos ou não provados, matriz de aceite
e rastreio seção a seção. PRD, spec e interfaces do MVP ficam intactos. As 25 decisões foram tomadas com
o Operador em quatro rodadas, todas conforme recomendado.

- **Seleção e interface.** Lambda é um segundo adapter, escolhido por instalação. Mesmas sete operações;
  o adapter declara capacidades, e "parar preserva disco" passa a ser consequência de uma delas.
- **Preservação.** O gate no Git remoto vale só para adapter sem disco persistente: antes de toda espera
  externa, da troca planejada e do fim de cada ativação da substituta. Três recusas seguidas geram Bloqueio.
- **Boots.** Espera externa encerra a MicroVM, sem suspender. Troca planejada mantém Execução, Slot e
  sessão; padrão de 3600 s com margem de 600 s. Dois boots sem commit novo geram Bloqueio.
- **Morte e perda.** O adapter observa o ambiente pelo serviço e a cessação encerra a ativação. A perda
  consome uma retomada; a substituta não repete o efeito incerto, conclui o resto, pergunta e publica.
  O hook de término empurra o commit perdido para uma ref de marcador, como melhor esforço.
- **Transporte, papéis e rede.** SSH sobre WebSocket; canal caído reconecta e devolve "indeterminado".
  Revisores só com `read`, mais usuário Unix somente leitura. Credenciais como no MVP, AWS só no host.
  Saída pública sem mediação é relaxamento aprovado; sem VPC.
- **Ambiente e operação.** A declaração de ambiente do MVP vale sem mudança, com uma imagem de MicroVM
  por chave a partir de Alpine. Instalação por template aplicado pelo Operador; quota conferida no
  `validate`; consumo em MicroVM-segundos, sem dólares; cleanup por tags.

**Não provado, com destino definido.** O guest Alpine depende do filho
[Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs](10-alpine-guest-on-lambda-proof.md),
que bloqueia o fechamento do mapa. O resto é gate de validação da implementação na matriz de aceite,
incluindo como obrigatórios os dois critérios reprovados na prova de continuidade. Suspend/resume, VPC,
escolha de sandbox por repositório e teto em dólares ficam fora da v2. A implementação do adapter é
esforço separado, fora deste mapa. Não é aceite da fábrica nem homologação de produção.

## Comments

- Originalmente aberto como revisão de sandbox, bloqueada pela prova Lambda; sem resolução prévia.
- Ampliação aprovada do mapa em 2026-11-14: este ticket é o ponto de consolidação integrada após
  a decisão de composição (08), que depende das duas provas. Preservado o caminho e o escopo de
  sandbox; adicionados harness/contexto/reconfiguração, sem antecipar resolução ou alterar o MVP.
- 2026-11-20: reescopo do Operador. A v2 trata só do sandbox Lambda MicroVMs; harnesses substituíveis ficam para a v3. Removidos os itens de harness e a dependência da decisão de composição (08, fechado); passa a depender só da prova Lambda (02).
- 2026-11-20: reivindicado pelo Operador (sessão Claude Code); branch `docs/v2-consolidation`, worktree `.worktrees/v2-consolidation/`, destino `main`.
- 2026-11-20: 24 decisões tomadas com o Operador em três rodadas, todas conforme recomendado. Proposta a [spec da v2](../spec.md) (requisitos V2-01 a V2-34, matriz de aceite e rastreio frente ao MVP) e aberto o filho [Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs](10-alpine-guest-on-lambda-proof.md). Pendente de aprovação do documento; a regra de três recusas do gate (V2-07) não foi perguntada nas rodadas e precisa de confirmação.
- 2026-11-21: o Operador confirmou a regra de três recusas do gate (V2-07) e aprovou a spec da v2; resolvido.
