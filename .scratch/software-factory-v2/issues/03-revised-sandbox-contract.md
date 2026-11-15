# Consolidar o PRD e a spec integrada da v2 para sandboxes e harnesses

Status: open
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 08

## Question

Como consolidar as direções de [sandbox](01-lambda-microvms-direction.md#answer) e
[harnesses](04-substitutable-harnesses-direction.md#answer), as provas e a
[decisão de composição](08-runtime-sandbox-composition-decision.md) em requisitos e contratos
implementáveis integrados da v2, preservando a autoridade e o escopo do MVP?

## Scope

- Trabalhar sobre evidências das duas trilhas e a decisão de composição, sem presumir êxito,
  suporte oficial Docker/SSH, autorização de assinatura ou equivalência de harnesses. Hipótese
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
- Incorporar a interface de execução e os adapters Pi/Claude sustentados pela decisão, preferindo
  evolução dos contratos existentes. Separar harness, modelo/provider e sandbox, com requisitos
  mínimos/capacidades e diagnóstico explícito das combinações suportadas.
- Definir seleção de harness por papel, perfil dedicado, autenticação nativa do Operador e registro
  efetivo por Execução; parada/configuração/reinício sem comando de troca ou fallback silencioso.
  Preservar identidade, histórico, consumo e controles do Trabalho ao substituir a sessão.
- Precisar pedido/instruções/estado Git/registros entregues à sessão substituta, sem transcript
  universal nem resumo semântico pelo controlador. Compatibilidade de sessão não é continuidade
  obrigatória do Trabalho e mudança de harness não elimina efeitos ambíguos.
- Definir instalação, observabilidade, quotas/custos, retenção/cleanup e matriz de aceite integrada.
  Distinguir evidência local, combinação com Lambda e gates de validação futura. Seleção automática
  de sandbox, Slots por adapter e política híbrida não são autorizados pela seleção de harness.

## Exit criteria

Decisões aprovadas pelo operador e documento da v2 rastreável, sem lacunas preenchidas por suposição,
com contratos e critérios de aceite sustentados pelas provas disponíveis. O mapa só pode encerrar
quando suas lacunas de desenho estiverem resolvidas; se necessário, abrir filhos específicos.
Não implementar o adapter nem alterar retroativamente o PRD/spec aprovado do MVP neste ticket.

## Comments

- Originalmente aberto como revisão de sandbox, bloqueada pela prova Lambda; sem resolução prévia.
- Ampliação aprovada do mapa em 2026-11-14: este ticket é o ponto de consolidação integrada após
  a decisão de composição (08), que depende das duas provas. Preservado o caminho e o escopo de
  sandbox; adicionados harness/contexto/reconfiguração, sem antecipar resolução ou alterar o MVP.
