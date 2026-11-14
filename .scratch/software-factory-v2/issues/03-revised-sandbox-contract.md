# Revisar o PRD e a spec da v2 para sandboxes reconstruíveis

Status: open
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — sandbox AWS Lambda MicroVMs](../map.md)
Blocked by: 02

## Question

Como traduzir a [direção aprovada](01-lambda-microvms-direction.md#answer) e os resultados de
[Validar Docker e transporte em Lambda MicroVMs](02-lambda-microvms-prototype.md) em requisitos
e contratos implementáveis da v2, preservando a autoridade e o escopo do MVP?

## Scope

- Trabalhar sobre evidências do protótipo, não presumir êxito nem suporte oficial de Docker/SSH.
  Se a hipótese falhar, obter decisão do operador antes de alterar backend, transporte ou escopo.
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
- Definir instalação, observabilidade, custos, retenção/cleanup e matriz de aceite da v2.
  Seleção de adapter e Slots por adapter só entram mediante decisão explícita, se necessários.

## Exit criteria

Decisões aprovadas pelo operador e documento da v2 rastreável, sem lacunas preenchidas por suposição,
com contratos e critérios de aceite sustentados pelas provas disponíveis. O mapa só pode encerrar
quando suas lacunas de desenho estiverem resolvidas; se necessário, abrir filhos específicos.
Não implementar o adapter nem alterar retroativamente o PRD/spec aprovado do MVP neste ticket.

## Comments

- Aberto e bloqueado pelo protótipo. Esta sessão não antecipa sua resolução ou sua aprovação.
