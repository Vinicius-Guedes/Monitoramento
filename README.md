# 📊 Monitoramento — Dashboard do Servidor

## 📌 Visão Geral

Dashboard de monitoramento em tempo real para o servidor viniciusguedes.cloud, exibindo métricas do sistema (CPU, memória, disco, uptime) e o status de todos os containers Docker.

A aplicação é composta por uma API Node.js + frontend estático, servida em container Docker com deploy automatizado.

**Demo:** https://monitoramento.viniciusguedes.cloud

---

## 🎯 Objetivo do Projeto

- Visualizar a saúde do servidor em tempo real
- Acompanhar o status de todos os containers Docker
- Identificar rapidamente problemas de recursos (CPU, memória, disco)
- Demonstrar domínio de **Node.js + Docker API + Dashboard responsivo**

---

## 🧱 Arquitetura

### ⚙️ API (Back-end)

Responsável por coletar métricas do sistema e listar containers.

- Desenvolvido com **Express.js** e **Dockerode**
- Lê métricas diretamente de `/proc` (CPU, memória, uptime)
- Consulta o Docker socket para listar containers
- Endpoints:
  - `GET /api/system` — CPU, memória, disco, uptime, hostname
  - `GET /api/containers` — Lista de containers com estado, imagem, portas

### 💻 UI (Front-end)

Responsável pela interface com o usuário.

- HTML, CSS e JavaScript puro (sem frameworks)
- Gauges circulares SVG com indicadores de cor:
  - 🟢 Verde — uso abaixo de 60%
  - 🟡 Amarelo — uso entre 60% e 85%
  - 🔴 Vermelho — uso acima de 85%
- Cards de containers com indicador visual de estado
- Auto-refresh a cada 5 segundos
- Indicador LIVE com detecção de falha de conexão

---

## 🔄 Fluxo de Execução

1. Usuário acessa o dashboard
2. Frontend faz requisição paralela para `/api/system` e `/api/containers`
3. API lê `/proc/stat`, `/proc/meminfo`, `/proc/uptime` e executa `df` para métricas do host
4. API consulta o Docker socket para listar containers
5. Frontend renderiza gauges e cards
6. A cada 5 segundos, o ciclo se repete automaticamente

---

## 🛠️ Tecnologias Utilizadas

### Back-end
- Node.js 20
- Express.js
- Dockerode (Docker Engine API)

### Front-end
- HTML5
- CSS3 (custom properties, grid, flexbox)
- JavaScript vanilla
- SVG para gauges circulares

### Infraestrutura
- Docker (Alpine)
- Traefik (reverse proxy + HTTPS)

---

## 📌 Funcionalidades

### 📈 Métricas do Sistema

- **CPU** — Modelo do processador, número de cores, uso em %
- **Memória** — Usada / total, livre, uso em %
- **Disco** — Usado / total, livre, uso em %
- **Uptime** — Tempo de atividade do servidor

---

### 🐳 Containers Docker

- Lista todos os containers (running, exited, restarting)
- Exibe para cada container:
  - Nome
  - Imagem
  - Estado com badge colorido
  - Tempo de atividade
  - Portas expostas
- Ordenação alfabética por nome

---

### 🔒 Segurança

- Basic Auth opcional (configurável via variáveis de ambiente)
- Docker socket montado como read-only
- `/proc` e rootfs montados como read-only

---

## 📦 Estrutura do Projeto

```bash
Monitoramento/
 ├── docker-compose.yml
 ├── README.md
 └── api/
 │    ├── Dockerfile
 │    ├── package.json
 │    └── server.js
 └── site/
      ├── index.html
      ├── css/
      │    └── style.css
      └── js/
           └── app.js
```

---

## 🎨 Convenções de UI

- Dark theme (fundo #0a0e1a)
- Cor de destaque indigo (#6366f1)
- Gauges circulares com transição suave
- Cards com borda lateral colorida por estado
- Hover com elevação e glow
- Layout responsivo (4 → 2 → 1 colunas)
- Indicador LIVE pulsante no header

---

## 🚀 Como Executar

### Com Docker (produção)

```bash
docker compose up -d --build
```

Sobe um container:
- **monitoramento** — Node.js servindo API + frontend na porta 3000

### Proteger com senha (opcional)

Descomente as variáveis no `docker-compose.yml`:

```yaml
environment:
  - AUTH_USER=admin
  - AUTH_PASS=SuaSenhaAqui
```

---

## 📎 Observações Técnicas

- CPU usage é amostrado a cada 2 segundos via delta de `/proc/stat`
- Docker socket (`/var/run/docker.sock`) é montado read-only para segurança
- `/proc` e `/` do host são montados read-only para leitura de métricas
- Deploy automático via GitHub Actions + rsync + Docker Compose
- HTTPS e roteamento gerenciados pelo Traefik
