const EventEmitter = require('events');

/**
 * SSEBroadcaster
 * Serviço singleton para gerenciamento de conexões Server-Sent Events (SSE)
 * e transmissão de eventos de pedidos em tempo real.
 */
class SSEBroadcaster extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);

    // Previne crash da aplicação caso erro seja emitido sem listener
    this.on('error', (err) => {
      console.error('[SSEBroadcaster] Erro no EventBus:', err.message);
    });

    // Armazena conexões ativas de clientes SSE
    this.clients = new Set();
    this.seq = 0;
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = 25000;
  }

  /**
   * Adiciona um novo cliente assinante SSE
   * @param {Object} req - Objeto de requisição HTTP / Express
   * @param {Object} res - Objeto de resposta HTTP / Express
   * @param {string} [clientId] - Identificador único da sessão/aba cliente
   */
  addClient(req, res, clientId = 'anonymous') {
    const rawClientId = clientId !== undefined && clientId !== null ? clientId : 'anonymous';
    const cleanClientId = String(rawClientId).replace(/[\r\n]/g, '').trim() || 'anonymous';

    // 1. Configurar cabeçalhos obrigatórios do padrão SSE
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (typeof res.status === 'function') {
      res.status(200);
    } else {
      res.statusCode = 200;
    }

    // Libera os cabeçalhos imediatamente para o cliente
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    // 2. Enviar comentário inicial de conexão estabelecida
    if (typeof res.write === 'function') {
      try {
        res.write(`: connected client_id=${cleanClientId}\n\n`);
      } catch (_e) {}
    }

    // 3. Registrar o cliente ativo
    const client = {
      id: ++this.seq,
      clientId: cleanClientId,
      req,
      res,
      connectedAt: Date.now()
    };
    this.clients.add(client);

    // Iniciar temporizador de heartbeat caso seja o primeiro assinante
    this.ensureHeartbeat();

    // 4. Configurar listeners de desconexão limpa
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.removeClient(client);
    };

    if (req && typeof req.on === 'function') {
      req.on('close', cleanup);
      req.on('end', cleanup);
    }

    if (res && typeof res.on === 'function') {
      res.on('close', cleanup);
      res.on('finish', cleanup);
      res.on('error', cleanup);
    }

    return client;
  }

  /**
   * Alias para addClient compatível com requisições Express
   */
  handleStreamRequest(req, res) {
    const clientId = (req && req.headers && req.headers['x-client-id'])
      || (req && req.query && req.query.client_id)
      || 'anonymous';
    return this.addClient(req, res, clientId);
  }

  /**
   * Alias alternativo para adicionar assinante por resposta
   */
  addSubscriber(res, clientId = null) {
    return this.addClient(res?.req || {}, res, clientId);
  }

  /**
   * Remove um cliente e fecha seu canal caso ainda não tenha sido encerrado
   * @param {Object} target - Cliente, resposta res ou ID do cliente
   */
  removeClient(target) {
    if (!target) return;
    for (const c of this.clients) {
      if (c === target || c.res === target || c.id === target) {
        this.clients.delete(c);
        try {
          if (c.res && !c.res.writableEnded && typeof c.res.end === 'function') {
            c.res.end();
          }
        } catch (_e) {}
        break;
      }
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }

  /**
   * Alias para remover assinante
   */
  removeSubscriber(target) {
    this.removeClient(target);
  }

  /**
   * Retorna a quantidade de clientes SSE conectados
   */
  getClientsCount() {
    return this.clients.size;
  }

  getSubscribersCount() {
    return this.clients.size;
  }

  getSubscriberCount() {
    return this.clients.size;
  }

  /**
   * Inicia o intervalo de keep-alive se houver assinantes
   */
  ensureHeartbeat() {
    if (!this.heartbeatTimer && this.clients.size > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.broadcastPing();
      }, this.heartbeatIntervalMs);

      // unref() garante que o timer não impede a finalização do processo Node (crucial para testes)
      if (typeof this.heartbeatTimer.unref === 'function') {
        this.heartbeatTimer.unref();
      }
    }
  }

  /**
   * Interrompe o temporizador de heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Envia um comentário de ping para manter conexões abertas através de proxies e roteadores
   */
  broadcastPing() {
    if (this.clients.size === 0) return;
    const pingMessage = ': ping\n\n';
    const deadClients = [];

    for (const client of this.clients) {
      try {
        if (client.res && client.res.writable !== false && !client.res.writableEnded && typeof client.res.write === 'function') {
          client.res.write(pingMessage);
        } else {
          deadClients.push(client);
        }
      } catch (_err) {
        deadClients.push(client);
      }
    }

    for (const dead of deadClients) {
      this.removeClient(dead);
    }
  }

  sendHeartbeat() {
    this.broadcastPing();
  }

  /**
   * Transmite evento para todos os clientes conectados e emite localmente no EventEmitter
   * @param {string|Object} eventOrPayload - Nome do evento ou objeto de payload completo
   * @param {Object} [maybeData] - Dados adicionais ou objeto do pedido
   * @param {string} [maybeClientId] - ID do cliente de origem
   */
  broadcast(eventOrPayload, maybeData, maybeClientId) {
    let payload;
    let eventType;

    if (typeof eventOrPayload === 'string') {
      eventType = eventOrPayload;
      if (maybeData && typeof maybeData === 'object' && ('order' in maybeData || 'order_id' in maybeData || 'type' in maybeData)) {
        payload = {
          type: eventType,
          timestamp: Date.now(),
          ...maybeData
        };
      } else {
        payload = {
          type: eventType,
          order: maybeData,
          client_id: maybeClientId || null,
          timestamp: Date.now()
        };
      }
    } else if (eventOrPayload && typeof eventOrPayload === 'object') {
      payload = {
        timestamp: Date.now(),
        ...eventOrPayload
      };
      eventType = payload.type || 'order_event';
    } else {
      return null;
    }

    // 1. Emitir localmente no EventEmitter para testes in-process e observers internos
    try {
      this.emit('message', payload);
      this.emit('order_event', payload);
      if (eventType) {
        this.emit(eventType, payload);
      }
      if (payload.order) {
        this.emit('order', payload);
      }
    } catch (emitErr) {
      console.error('[SSEBroadcaster] Erro ao emitir evento local:', emitErr.message);
    }

    // 2. Formatar chunk no padrão SSE oficial:
    // event: message\ndata: ${JSON.stringify(payload)}\n\n
    const sseChunk = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

    // 3. Transmitir para clientes conectados com write guards e remoção de clientes mortos
    const deadClients = [];
    for (const client of this.clients) {
      try {
        if (client.res && client.res.writable !== false && !client.res.writableEnded && typeof client.res.write === 'function') {
          client.res.write(sseChunk);
        } else {
          deadClients.push(client);
        }
      } catch (_err) {
        deadClients.push(client);
      }
    }

    for (const dead of deadClients) {
      this.removeClient(dead);
    }

    return payload;
  }

  /**
   * Fecha todas as conexões ativas e limpa o estado
   */
  reset() {
    this.stopHeartbeat();
    for (const client of Array.from(this.clients)) {
      try {
        if (client.res && !client.res.writableEnded && typeof client.res.end === 'function') {
          client.res.end();
        }
      } catch (_e) {}
    }
    this.clients.clear();
  }

  closeAll() {
    this.reset();
  }

  closeAllClients() {
    this.reset();
  }
}

// Singleton exportado
const sseBroadcaster = new SSEBroadcaster();
sseBroadcaster.SSEBroadcaster = SSEBroadcaster;
sseBroadcaster.SseBroadcaster = SSEBroadcaster;
sseBroadcaster.sseBroadcaster = sseBroadcaster;
sseBroadcaster.broadcastOrderEvent = (data) => sseBroadcaster.broadcast(data);

module.exports = sseBroadcaster;
