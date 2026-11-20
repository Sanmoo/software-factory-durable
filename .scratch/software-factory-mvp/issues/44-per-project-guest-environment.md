# 44: Ambiente do guest por projeto (runtime e dependências do repositório prontos antes do Builder)

**What to build:** hoje o guest é genérico por desenho (spec §7.4): Alpine, Git/gh, certificados e Docker, sem a stack de nenhum projeto.
Os runtimes e dependências do repositório são instalados pelo próprio Builder em cada Trabalho, com `apk`, guiado pela skill
`alpine-diagnostics`. No piloto (ticket 35, 2026-11-18) isso apareceu como custo e como ambiguidade logo no primeiro gate:

- `Sanmoo/java-springboot-event-sourcing` exige JDK 25 (README). No #125 o Builder rodou `./gradlew test --tests …` e recebeu
  "JAVA_HOME is not set and no 'java' command could be found"; não instalou nada e abriu uma Pergunta
  (`010e0389-0fd6-42cc-a4a0-9ab3ced05a2d`). Parte da causa foi o texto do Ticket ("if the environment prevents a test from running, stop and
  say why"), escrito pelo supervisor.
- O mesmo vai acontecer em cada Trabalho do mesmo repositório (#124, #126, #127, #128): cada Builder descobre a falta, decide sozinho se instala,
  qual versão e como, e gasta requisições e tokens nisso. Dois Builders podem escolher versões diferentes.
- No ticket 24 (v2/v3) a mesma falta levou a receita a rodar o Gradle num container `eclipse-temurin:25-jdk` do Docker do guest: funcionou, mas
  é detalhe de infraestrutura que acabou escrito no gate do Ticket.

**Demanda do operador:** o gate é característica do projeto (`./gradlew check acceptanceTest`) e não deve carregar detalhe de ambiente. O
ambiente em que ele roda deve ser uma propriedade do repositório configurado, preparada antes do Builder e igual para todos os Trabalhos
desse repositório.

Decisões a tomar (triagem):

1. **Onde o ambiente é declarado:** na configuração da instalação (`repositories[].environment`), num arquivo do repositório (ex.
   devcontainer-like) ou nos dois, com precedência explícita. Um arquivo do repo é entrada não confiável: nunca executa no host (spec §7.3).
2. **Como é preparado:** pacotes `apk` fixados por versão instalados uma vez num disco base por repositório (camada sobre a base da release),
   ou uma imagem de container fixada por digest usada pelos gates; ou as duas formas.
3. **Quando e por quem:** preparo pelo controlador antes do primeiro boot (resultado registrado e verificável), ou primeiro Trabalho prepara
   e os seguintes reutilizam. Falha de preparo é impedimento visível do Trabalho, nunca fallback silencioso.
4. **Identidade e reprodutibilidade:** o ambiente entra na identidade do Trabalho/Execução (manifesto com versões e hashes), como os assets do
   guest; mudança de declaração invalida o disco preparado.
5. **Relação com a skill Alpine e com o Builder:** o Builder continua podendo instalar o que o Ticket exige além do ambiente declarado, e
   registra; o ambiente declarado nunca é trocado silenciosamente (sem troca de stack/versão, spec §7.4).
6. **Escopo:** pós-MVP ou parte do MVP. Até a decisão, o piloto segue com a regra atual (Builder instala com `apk` e registra).

**Blocked by:** 53

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Decisões da triagem de 2026-11-19 (abaixo) registradas na spec §7.4 (ou ADR) junto da implementação.
- [ ] Todo repositório declara seu ambiente em `.factory/environment.yaml` (esquema fechado e validado: pacotes `apk` com versão exata e,
  opcionalmente, imagens de container fixadas por digest para baixar antes; sem scripts nem comandos livres). A Factory confia no arquivo:
  não há aprovação do operador.
- [ ] Repositório sem `.factory/environment.yaml` (ou com arquivo inválido): o Trabalho não começa, impedimento `ENVIRONMENT_NOT_DECLARED`
  (ou de arquivo inválido com o caminho do erro) que diz o que criar; nenhum fallback para o guest genérico.
- [ ] O arquivo é lido do commit base na criação do Trabalho e fixado no Trabalho pelo hash; mudança do arquivo vale para Trabalhos seguintes.
- [ ] O controlador prepara, antes do primeiro boot, um disco base por (repositório, hash do arquivo) sobre os assets da release, numa VM de
  preparo com acesso só ao mirror Alpine e aos registries das imagens declaradas; o arquivo nunca executa no host (o host só lê e valida o
  YAML). Versão ausente no mirror recusa o preparo, sem trocar de versão. Trabalhos seguintes com o mesmo hash reutilizam o disco base.
- [ ] Identidade do ambiente = hash do arquivo + manifesto resolvido (versões e digests). Hash novo gera disco base novo usado só por ambientes
  novos; ambientes já preparados continuam com o anterior, registrado.
- [ ] Teste offline: um repositório que declara JDK 25 tem o disco base preparado com o manifesto esperado, e o mesmo ambiente nos Trabalhos
  seguintes (identidade igual).
- [ ] O gate do Ticket fica só o comando do projeto (`./gradlew check acceptanceTest`); nenhum detalhe de ambiente no corpo do Ticket.
- [ ] Falha de preparo vira impedimento visível com causa, sem retry implícito e sem fallback de imagem/versão; retomada pelo
  `--retry-blocked-start` do ticket 50.
- [ ] O Builder pode instalar extras que o Ticket exija e registra; nunca troca a stack/versão declarada. Skills dizem que o ambiente declarado
  já está pronto (nova versão do pacote de skills, sobre a do ticket 53).

## Comments

- Origem: piloto 35, Pergunta do #125 em `Sanmoo/java-springboot-event-sourcing`; ensaios q24 v2/v3 (`docs/evidence/24-three-builders-fifo-and-isolation.md`).
- Spec: §7.4 (guest, Docker e persistência), skill `factory-skills-v7/skills/alpine-diagnostics`.
- 2026-11-19 triagem (operador, decisões registradas): declaração no próprio repositório, obrigatória para todo repositório, em
  `.factory/environment.yaml` com esquema fechado (apk com versão exata + imagens por digest); a Factory sempre confia no arquivo (sem
  aprovação); sem arquivo o Trabalho não começa; lido do commit base e fixado no Trabalho; disco base por (repositório, hash) preparado pelo
  controlador numa VM de preparo; mudança vale só para ambientes novos; Builder pode instalar extras sem trocar a stack; MVP, antes do piloto 2,
  depois do 53. O `.factory/environment.yaml` do `Sanmoo/java-springboot-event-sourcing` (JDK 25) entra por PR mergeado pelo operador na
  preparação do piloto 2; a prova real (Testcontainers/Ryuk no guest) está no [54](54-pilot-2.md).
