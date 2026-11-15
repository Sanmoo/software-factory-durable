# Definir a direção da v2 para Lambda MicroVMs

Status: resolved
Assignee: operador, assistido pelo agente desta sessão
Claim context: registro retrospectivo da entrevista aprovada; branch docs/software-factory-v2-lambda, worktree .worktrees/software-factory-v2-lambda/; destino main no checkout principal, sem push.
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: none

## Question

Como admitir sandboxes AWS gerenciadas e de duração limitada depois do MVP, sem transformar
VFS, disco preservado ou um boot ilimitado em exigências universais, e sem adicionar
complexidade própria desnecessária?

## References

- [PRD do MVP](../../software-factory/prd.md).
- [Spec técnica do MVP](../../software-factory/spec.md).
- [Interface pública Sandbox e composição do MVP](../../software-factory/module-public-interfaces.md).
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](../../software-factory/issues/07-isolation-choice.md).
- [Definir o contrato e o perfil distribuível do adapter Gondolin](../../software-factory/issues/19-gondolin-adapter-contract.md).

## Comments

- O operador confirmou o resumo completo da compreensão compartilhada e autorizou seu registro.
  Este ticket resolve a direção pós-MVP, não a viabilidade técnica ou a implementação.
- Validação do registro: `git diff --check`, cinco documentos e 58 links/âncoras locais válidos;
  três tickets com status/tipos/labels e dependências em cadeia conferidos. A alteração no mapa
  original limita-se a um link de roadmap; PRD/spec e tickets do MVP permanecem inalterados.
  URLs externas e funcionamento da AWS não foram validados nesta etapa documental.
- Q1/Q3/Q4/Q5: aceitas motivação de hardware/escala, instalação própria, fronteira de dados
  e criação de registro v2. Q2: o operador rejeitou invariantes universais excessivamente rígidos.
- Q6–Q9: aprovados contrato mínimo + capacidades, disco reconstruível, Docker conforme repo
  e mudanças somente na v2. Q10: EC2 própria rejeitada; preferência por serviços gerenciados/serverless.
- Q11–Q14: rodada substituída pelo foco em Lambda; não considerar aprovadas as propostas de
  política híbrida, Slots por adapter ou sincronização nas fronteiras de controle.
- Q15 reformulada pelo operador: implementação/revisão/publicação no mesmo boot; ao passar
  ao humano, nenhum arquivo por comitar nem commit sem push. Isso supera Q16–Q18 nas partes
  de S3/bundle, checkpoint em todo handoff e preservação genérica por sincronização.
- Q19/Q20/Q21/Q22: aceitas prova futura, push WIP antes de perguntas, recuperação substituta
  após perda e gate Git. A confirmação adicional antes de provisionar foi mantida explicitamente.
- Q23 inicial questionada pela complexidade; Q23' aceita SSH/WebSocket como primeira hipótese
  a validar, não servidor exec próprio imediato.
- Q24/Q25/Q26: aceitas rotação antecipada via Git, saída padrão pela internet com VPC para
  exceções e estrutura documental separada. O resumo final foi confirmado antes das edições.

## Answer

### Objetivo e autoridade

Explorar **AWS Lambda MicroVMs como adapter pós-MVP**, para reduzir a dependência de hardware
local e ampliar capacidade. Sem EC2 administrada por nós como requisito ou etapa preliminar.
Uma instalação de um operador, na própria conta AWS; sem SaaS, multi-tenant ou HA.

O MVP continua com as decisões aprovadas. Este Answer é direção para a v2; não altera o
PRD/spec vigente nem autoriza implementar o adapter. Detalhes condicionados ao protótipo
permanecem no [próximo ticket](02-lambda-microvms-prototype.md).

### Contrato por propriedades e capacidades

VFS, workspace montado no host e disco persistente não são exigências universais. São mecanismos
possíveis, incluindo os usados pelo Gondolin. A interface deverá permitir diferentes formas de
executar ferramentas, preservar o trabalho e reconstruir um ambiente com vida limitada.

Confinamento, ferramentas controladas por papel e cessação confirmável continuam necessários.
Docker e disco persistente tornam-se capacidades declaradas; a necessidade de Docker depende
do repositório. Ausência de capacidade exigida gera diagnóstico, não fallback silencioso.
Pacotes, caches, arquivos ignorados e dados do Docker precisam ser reconstruíveis no perfil Lambda.

Controlador, workers/sessões e SQLite continuam no host. A chave emissora da GitHub App não
vai para a MicroVM; somente acessos reduzidos necessários ao trabalho podem chegar ao ambiente.
Configuração e particularidades do serviço ficam encapsuladas no adapter/interface, não espalhadas
pelo controlador.

### Preservação no Git remoto

Implementação, revisões, tratamento dos achados e push normalmente cabem **no mesmo boot**.
Não há obrigação de checkpoint entre Builder e revisores quando o ambiente continua disponível.
Antes de qualquer entrega do controle ao humano, inclusive uma pergunta durante a implementação,
o Builder faz commit e push na branch do Trabalho; pode ser WIP, mesmo antes de existir PR.

O gate verifica no guest:

1. workspace limpo, incluindo untracked não ignorados;
2. ausência de stash;
3. `HEAD` correspondente à branch efetivamente publicada no `origin`, sem confiar apenas em
   uma referência de acompanhamento local desatualizada.

Falha retorna ao Builder para correção; não pode ser apresentada como preservação concluída.
Arquivos ignorados são descartáveis/reconstruíveis. O procedimento não autoriza versionar segredos
ou dados impróprios: se não puder publicar com segurança, reportar bloqueio em vez de forçar commit.
A revisão implementável deverá precisar esses diagnósticos e sua interação com os limites.

A retomada parte do Git remoto. Não adotar checkpoint S3/git bundle como mecanismo inicial,
nem exigir cópia do workspace no host. Preservar disco no Gondolin continua sendo capacidade extra.

### Perda antes do push

Se a MicroVM morrer antes da publicação, aceita-se a perda do trabalho local desde o último push,
com ocorrência e consumo visíveis. Recuperar por sessão substituta a partir do último estado no
`origin`, conservando a sessão antiga como evidência. Não retomar silenciosamente um contexto que
supõe arquivos inexistentes e não repetir cegamente efeitos externos ambíguos.

### Duração limitada e troca planejada de boot

O teto de oito horas relatado para a Lambda não torna o adapter incompatível por definição.
Antes do limite, com margem declarada pelo adapter, impedir novas chamadas longas, pedir
commit WIP + push, verificar o gate, confirmar cessação e iniciar outro boot sobre o estado remoto.
Reconstruir o ambiente e continuar a sessão somente se o estado restaurado for compatível;
morte antecipada cai no caminho de perda/recuperação substituta.

Uma chamada indivisível maior que a duração disponível gera diagnóstico, não reinícios infinitos.
A troca planejada não é por si só cancelamento ou novo Trabalho; seus custos continuam reais e
observáveis. Duração/margem e mecanismos concretos de parada/retomada dependem da prova e da
revisão dos contratos. Não depender exclusivamente de hooks de terminação para publicar trabalho.

### Transporte e rede: hipóteses a provar

Primeira opção: **SSH transportado por WebSocket pelo `HTTP_INGRESS`**, com componentes existentes,
para comandos e arquivos. Validar autenticação AWS e SSH, renovação/expiração de token, streaming,
exit code, interrupção, desconexões e isolamento por papel. Não presumir que SSH ou autenticação
no proxy, sozinhos, garantem revisão somente leitura ou tornam o endpoint interno não confiável.
`SHELL_INGRESS` não é o caminho de produção proposto.

Servidor exec próprio é alternativa explícita se a primeira hipótese falhar; não uma construção
já aprovada. O custo total de componentes, configuração, segurança e operação precisa ser comparado.

Preferir `INTERNET_EGRESS` como saída padrão, VPC somente para exceções configuradas. Isso não
prova automaticamente mediação HTTP(S), isolamento de todas as redes privadas ou compatibilidade
de DNS: documentar diferenças frente ao MVP e demonstrar as propriedades necessárias no protótipo.

### Evidência e próximos passos

A pesquisa da sessão encontrou indícios de Docker funcional, mas **não comprovou o perfil necessário
à fábrica**, em particular Testcontainers/Ryuk. Relatos de terceiros não equivalem a suporte oficial.
As fontes iniciais estão no ticket de protótipo, para revalidação; nenhum experimento foi executado.

Há concordância em princípio com um protótipo descartável. Antes de executar, confirmar conta,
região, permissões, orçamento e cleanup; não inferir autorização para provisionar desta resolução.
Depois da prova, revisar o PRD/spec **da v2**, preservando a autoridade do MVP.
