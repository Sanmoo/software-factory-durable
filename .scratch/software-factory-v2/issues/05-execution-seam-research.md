# Localizar a interface de execução e as dependências entre harness e sandbox

Status: resolved
Assignee: Pi, sob supervisão do Operador
Claim context: branch research/v2-execution-seam, worktree .worktrees/v2-execution-seam/; destino main no checkout principal. Implementação de referência: integration/software-factory-mvp em aabe06abfb20e83593020c0fee19b078d235466b, snapshot somente leitura .worktrees/v2-execution-seam-source/.
Type: research
Label: wayfinder:research
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 04

## Question

Quais contratos existentes podem atender Pi e Claude Code, e quais diferenças precisam ser provadas
antes de desenhar uma interface implementável, considerando a direção de sandbox reconstruível?

## References

- [Direção de harnesses](04-substitutable-harnesses-direction.md#answer).
- [Direção de sandbox](01-lambda-microvms-direction.md#answer).
- [Interfaces públicas do MVP](../../software-factory/module-public-interfaces.md).
- [Spec do MVP](../../software-factory/spec.md).
- [Pesquisa de assinatura Claude Code](../../software-factory/research/claude-code-subscription.md).

## Scope

- Inventariar Workers, protocolo, controle de sessão, ferramentas e Sandbox nos documentos e na
  implementação disponível; registrar refs/versões e distinguir aprovado, implementado e demonstrado.
  Worktrees/branches de implementação em andamento são evidência de estado, não autoridade aprovada.
- Localizar o seam adequado: preferir reutilizar/refinar Workers se suficiente, sem camada pass-through,
  framework de plugins ou abstração de todos os harnesses imagináveis.
- Confrontar CLI e Agent SDK oficiais com Pi: ativação, eventos, pergunta/revisão, sessão substituta,
  cancelamento/cessação, modelos por papel, uso indisponível versus zero e erros/quotas.
- Avaliar localização do loop e das ferramentas, confinamento, descobertas de configuração e gestão
  nativa de credenciais. Não presumir shell Claude seguro no host nem equivalência de allowedTools
  com proibição técnica de escrita. Não copiar tokens do Operador para outro harness.
- Distinguir interface de harness e sandbox, requisitos mínimos e capacidades da combinação.
  Identificar pressupostos host/guest da direção v2 que precisariam voltar à decisão; não alterá-los.
- Definir hipóteses e cenários que desbloqueiem a spec da prova, incluindo fonte mínima de contexto
  independente de transcript e reconfiguração entre inicializações. Não desenhar a interface final.
- Reutilizar pesquisa existente, revalidando somente fatos mutáveis/decisivos nas fontes primárias.
  Não exigir conclusão da prova Lambda para investigar a trilha de harness.

## Exit criteria

Relatório com rastreabilidade para contratos/código/fontes, lacunas e hipóteses testáveis, sem decisão
de adoção ou compatibilidade alegada sem prova. Propor ao operador alternativas decisivas se houver
conflito de autoridade/permissão. Sem instalar, executar inferência, login, provisionar ou implementar.

## Answer

Pesquisa documental concluída em **2026-11-15**, revisada pelo supervisor:
[Seam de execução: harness versus sandbox](../research/execution-seam.md).
Implementação fixada no SHA `aabe06abfb20e83593020c0fee19b078d235466b` da integração MVP;
fontes, símbolos, linhas e limites de evidência estão no relatório. A branch de integração pode
avançar sem alterar a referência desta pesquisa; evidência não foi reexecutada nesta sessão.

- **Localização:** Workers já é o seam público candidato, separado de Sandbox/Protocol/Records.
  Hipótese para a prova: refinar esse módulo, sem criar camada pass-through ou framework de plugins.
  Há acoplamentos Pi concretos em sessão/perfil, bootstrap host, recibos, tools/resources e composição;
  não é suficiente mudar provider/modelo. Não foi escolhida uma interface implementável definitiva.
- **Hipótese Claude:** loop oficial no host, built-ins removidos e MCP explícito para ferramentas
  confinadas e sinais ao controlador. SDK e CLI são alternativas documentadas; o SDK fornece mais
  mecanismos de integração diretos. Isso não comprova compatibilidade ou enquadramento comercial.
  Loop no guest alteraria direção aprovada e precisa voltar ao Operador se necessário.
- **Gaps decisivos:** suspensão sem nova inferência durante review/pergunta, filtragem antes de
  persistência nativa, inventário efetivo de recursos/configuração, cessação MCP/background e
  autenticação nativa dedicada sem fallback/contorno de quota. `allowedTools` não prova restrição;
  `tools: []`, MCP explícito e hooks possuem mecanismos documentados, ainda sujeitos a prova.
- **Continuidade v2:** substituição de sessão já existe no MVP, mas `recoveryContext` exige ambiente
  reutilizado. Reconstrução de clone confirmado no origin exige revisão de contrato/contexto.
  O fluxo MVP também proíbe push na implementação e publica em modo separado; WIP antes de espera
  humana, aprovado na direção v2, exige tratar modos/autorização/gate explicitamente. Nenhuma dessas
  diferenças foi aplicada à implementação ou apresentada como defeito do MVP.
- **Entrada para a spec da prova:** dez cenários T1–T10 cobrem papéis, superfície, suspensão,
  pergunta, segredos/transcript, cessação, reconfiguração Pi↔Claude, preservação/perda, perfil/quota e
  review/upgrade. Podem ser especificados sem aguardar Lambda; não homologam sua composição.

O [próximo ticket](06-harness-proof-spec.md) está desbloqueado para discutir e especificar a prova,
sem autorização automática para executá-la. Decisão de adoção, assinaturas/recursos autorizados e
contratos finais permanecem nos gates próprios. Nenhum modelo, login, credencial, instalação, teste
ou provisionamento foi executado nesta pesquisa.

## Comments

- Autoridade desta execução: o Operador autorizou iniciar a investigação após conferir o avanço do
  tracker MVP; escopo limitado ao ticket05 e seus registros. Integração documental local em main,
  sem push; snapshot somente leitura e worktree de pesquisa removíveis após validação/integração.
- Validação do relatório: 184 linhas, três links locais e 26 ocorrências de caminhos de código/evidência
  com limites de linhas conferidos; snapshot fixado e limpo. Fontes oficiais foram lidas pelo acesso
  web do supervisor após HTTP 403 no acesso direto do pesquisador; não se tratou erro como conteúdo.
  `git diff --check` e probe LSP sem erros/warnings. Não são testes de runtime nem provas de Claude.
