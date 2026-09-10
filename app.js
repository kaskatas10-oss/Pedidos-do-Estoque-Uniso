/**
 * app.js
 * ===========================================================================
 * Controle de SLA de Pedidos - UNISO
 * ---------------------------------------------------------------------------
 * Aplicativo web para acompanhamento operacional de prazos (SLA) de pedidos,
 * com sincronização em tempo real via Cloud Firestore.
 *
 * Este arquivo está organizado nas seguintes seções:
 *   1. Configuração centralizada das faixas de SLA
 *   2. Estado global da aplicação
 *   3. Utilitários de data (cálculo em dias úteis)
 *   4. Cálculo e classificação de SLA
 *   5. Integração com o Firebase (Authentication + Firestore)
 *   6. Operações de CRUD dos pedidos
 *   7. Renderização de interface (dashboard, painel, tabela, histórico, SVG)
 *   8. Modais (novo/editar pedido e detalhamento de grupo)
 *   9. Filtros, busca e eventos de interface
 *  10. Tema claro/escuro (dark mode) e modo celular (visualização manual)
 *  11. Dados de demonstração (opcional, não executado automaticamente)
 *  12. Inicialização da aplicação
 * ===========================================================================
 */

/**
 * IMPORTANTE: o Firebase (firebase-config.js e o SDK do Firestore, carregado
 * do CDN gstatic.com) é importado de forma DINÂMICA dentro de
 * carregarFirebaseEIniciar() (seção 5), em vez de um "import" estático no
 * topo do arquivo. Isso é proposital: um "import" estático que falha (rede
 * bloqueada, firewall corporativo, extensão de bloqueio de anúncios, erro
 * nas credenciais) impede a execução de TODO o resto do app.js - inclusive
 * funções que não têm nada a ver com o Firebase, como o dark mode, o modo
 * celular e a validação dos formulários. Com o import dinâmico, uma falha
 * ali é capturada e tratada (mostra o indicador vermelho no cabeçalho e uma
 * mensagem de erro), enquanto o restante da interface continua funcionando
 * normalmente.
 */
let db, auth, signInAnonymously, onAuthStateChanged;
let collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, serverTimestamp, query, orderBy;
let colecaoPedidos;

const NOME_COLECAO = 'pedidos';

/* =========================================================================
   1. CONFIGURAÇÃO CENTRALIZADA DAS FAIXAS DE SLA
   -------------------------------------------------------------------------
   Todos os limites de classificação visual do SLA ficam concentrados aqui
   para facilitar alterações futuras sem precisar alterar a lógica do
   restante do sistema. Todas as contagens de dias são em DIAS ÚTEIS
   (segunda a sexta-feira), sem considerar feriados.
   ========================================================================= */
const CONFIG_SLA = {
  // Regras de classificação (em dias úteis restantes até o vencimento)
  diasRestantesAmarelo: 3,        // exatamente 3 dias úteis restantes = amarelo
  diasRestantesVermelhoMin: 1,    // 1 ou 2 dias úteis restantes = vermelho
  diasRestantesVermelhoMax: 2,
  diasAtrasoMarromMax: 4,         // do 1º ao 4º dia útil de atraso = marrom
  diasAtrasoRoxoMin: 5,           // a partir do 5º dia útil de atraso = roxo

  // Cores e rótulos usados nos badges, cartões e no painel consolidado
  cores: {
    verde: { bg: '#e3f4e8', texto: '#1e7d34', label: 'No prazo' },
    amarelo: { bg: '#fff6d9', texto: '#8a6100', label: 'Atenção' },
    vermelho: { bg: '#fbe4e4', texto: '#c11e1e', label: 'Crítico' },
    'vence-hoje': { bg: '#fbe4e4', texto: '#c11e1e', label: 'Vence hoje' },
    marrom: { bg: '#efe1d5', texto: '#7a4a24', label: 'Atrasado' },
    roxo: { bg: '#ecdff5', texto: '#6a1b9a', label: 'Atrasado' },
    finalizado: { bg: '#eceff1', texto: '#546e7a', label: 'Finalizado' }
  }
};

/* =========================================================================
   1-B. CONFIGURAÇÃO DO STATUS DE SEPARAÇÃO (operacional, independente do SLA)
   -------------------------------------------------------------------------
   Controla o fluxo físico de separação do pedido (registrado pelo operador
   através do botão "Registro de Separação"), sem nenhuma relação com a
   Situação (prazo do SLA) nem com o checkbox "Concluir" definidos acima.
   ========================================================================= */
const CONFIG_SEPARACAO = {
  'a-separar': { cor: 'var(--cor-perigo)', label: 'A Separar' },
  'em-separacao': { cor: 'var(--cor-alerta)', label: 'Em Separação' },
  separado: { cor: 'var(--cor-sucesso)', label: 'Separado' }
};

/* =========================================================================
   2. ESTADO GLOBAL DA APLICAÇÃO
   ========================================================================= */
const estado = {
  pedidos: [],               // cache local dos pedidos sincronizados do Firestore
  agrupamentoHistorico: 'recebimento',
  filtros: {
    texto: '',
    status: '',
    recebIni: '',
    recebFim: '',
    vencIni: '',
    vencFim: ''
  }
};

/* =========================================================================
   3. UTILITÁRIOS DE DATA (CÁLCULO EM DIAS ÚTEIS)
   ========================================================================= */

// Verifica se uma data (objeto Date) cai em dia útil (segunda a sexta).
function ehDiaUtil(data) {
  const diaSemana = data.getDay(); // 0 = domingo, 6 = sábado
  return diaSemana !== 0 && diaSemana !== 6;
}

// Converte uma string 'yyyy-mm-dd' em um objeto Date à meia-noite local.
function parseDataLocal(stringISO) {
  const [ano, mes, dia] = stringISO.split('-').map(Number);
  return new Date(ano, mes - 1, dia);
}

// Converte um objeto Date em string 'yyyy-mm-dd'.
function formatarISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// Converte uma string 'yyyy-mm-dd' em 'dd/mm/aaaa' para exibição.
function formatarBR(stringISO) {
  if (!stringISO) return '-';
  const [ano, mes, dia] = stringISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

// Converte um Timestamp do Firebase (ou Date/ISO) em 'dd/mm/aaaa hh:mm'.
function formatarDataHoraBR(timestamp) {
  if (!timestamp) return '-';
  const data = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return data.toLocaleString('pt-BR');
}

// Igual a formatarDataHoraBR, mas fixando o fuso horário de Brasília
// (America/Sao_Paulo), independentemente do fuso configurado no computador
// de quem estiver vendo a tela. Usada nos registros de separação, para que
// o tempo medido entre operadores de computadores diferentes seja sempre
// comparável na mesma referência de horário.
function formatarDataHoraBrasilia(timestamp) {
  if (!timestamp) return '-';
  const data = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return data.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// Retorna a data de hoje no formato 'yyyy-mm-dd' (fuso horário local).
function hojeISO() {
  return formatarISO(new Date());
}

// Converte um Timestamp do Firebase em string 'yyyy-mm-dd' (ou null).
function timestampParaISO(timestamp) {
  if (!timestamp) return null;
  const data = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return formatarISO(data);
}

/**
 * Soma (ou subtrai, se o valor for negativo) uma quantidade de dias úteis
 * a partir de uma data inicial. O dia inicial NÃO é contado como um dos
 * dias do prazo - a contagem começa a partir do próximo dia.
 * Usada tanto para calcular vencimentos quanto para gerar dados de teste.
 */
function somarDiasUteis(stringISOInicial, quantidadeDiasUteis) {
  const quantidade = Math.trunc(quantidadeDiasUteis);
  const direcao = quantidade >= 0 ? 1 : -1;
  let restante = Math.abs(quantidade);
  const cursor = parseDataLocal(stringISOInicial);
  while (restante > 0) {
    cursor.setDate(cursor.getDate() + direcao);
    if (ehDiaUtil(cursor)) {
      restante--;
    }
  }
  return formatarISO(cursor);
}

/**
 * Calcula a diferença em DIAS ÚTEIS entre duas datas (strings 'yyyy-mm-dd').
 * Retorna um número positivo se dataFinal for depois de dataInicial,
 * negativo se for antes, e 0 se forem iguais.
 */
function diferencaEmDiasUteis(dataInicialISO, dataFinalISO) {
  if (dataInicialISO === dataFinalISO) return 0;
  const sinal = dataFinalISO > dataInicialISO ? 1 : -1;
  const cursor = parseDataLocal(dataInicialISO);
  const alvoISO = dataFinalISO;
  let contagem = 0;
  while (formatarISO(cursor) !== alvoISO) {
    cursor.setDate(cursor.getDate() + sinal);
    if (ehDiaUtil(cursor)) {
      contagem += sinal;
    }
  }
  return contagem;
}

/* =========================================================================
   4. CÁLCULO E CLASSIFICAÇÃO DE SLA
   ========================================================================= */

// Calcula a data de vencimento a partir da data de recebimento + SLA (dias úteis).
function calcularDataVencimento(dataRecebimentoISO, slaDias) {
  return somarDiasUteis(dataRecebimentoISO, Number(slaDias));
}

/**
 * Classifica um pedido de acordo com a configuração central de SLA.
 * Retorna um objeto com: chave, label, bg, texto, diasRestantes (e
 * diasAtraso quando aplicável). Pedidos finalizados sempre retornam a
 * chave 'finalizado'.
 */
function classificarPedido(pedido) {
  if (pedido.status === 'finalizado') {
    return { chave: 'finalizado', diasRestantes: null, ...CONFIG_SLA.cores.finalizado };
  }

  const diasRestantes = diferencaEmDiasUteis(hojeISO(), pedido.dataVencimento);

  if (diasRestantes > CONFIG_SLA.diasRestantesAmarelo) {
    return { chave: 'verde', diasRestantes, ...CONFIG_SLA.cores.verde };
  }
  if (diasRestantes === CONFIG_SLA.diasRestantesAmarelo) {
    return { chave: 'amarelo', diasRestantes, ...CONFIG_SLA.cores.amarelo };
  }
  if (diasRestantes >= CONFIG_SLA.diasRestantesVermelhoMin && diasRestantes <= CONFIG_SLA.diasRestantesVermelhoMax) {
    return { chave: 'vermelho', diasRestantes, ...CONFIG_SLA.cores.vermelho };
  }
  if (diasRestantes === 0) {
    return { chave: 'vence-hoje', diasRestantes, ...CONFIG_SLA.cores['vence-hoje'] };
  }

  // diasRestantes < 0: pedido em atraso
  const diasAtraso = Math.abs(diasRestantes);
  if (diasAtraso <= CONFIG_SLA.diasAtrasoMarromMax) {
    return { chave: 'marrom', diasRestantes, diasAtraso, ...CONFIG_SLA.cores.marrom };
  }
  return { chave: 'roxo', diasRestantes, diasAtraso, ...CONFIG_SLA.cores.roxo };
}

/**
 * Calcula o resultado da finalização de um pedido: se foi concluído
 * antecipadamente, no prazo ou com atraso, e a diferença em dias úteis.
 */
function calcularResultadoFinalizacao(pedido, dataFinalizacaoISO) {
  const diferenca = diferencaEmDiasUteis(pedido.dataVencimento, dataFinalizacaoISO);
  let resultadoSLA;
  if (diferenca > 0) resultadoSLA = 'atrasado';
  else if (diferenca < 0) resultadoSLA = 'antecipado';
  else resultadoSLA = 'no_prazo';
  return { resultadoSLA, diasDiferencaFinalizacao: Math.abs(diferenca) };
}

// Ordem de criticidade usada para ordenar a lista de pedidos.
function ordemCriticidade(classificacao) {
  const mapa = {
    roxo: 0,
    marrom: 1,
    'vence-hoje': 2,
    vermelho: 3,
    amarelo: 4,
    verde: 5,
    finalizado: 6
  };
  return mapa[classificacao.chave] ?? 9;
}

// Texto exibido no badge de situação de cada pedido.
function textoSituacao(pedido, classificacao) {
  if (pedido.status === 'finalizado') {
    if (pedido.resultadoSLA === 'antecipado') return `FINALIZADO (Antecipado ${pedido.diasDiferencaFinalizacao}d)`;
    if (pedido.resultadoSLA === 'atrasado') return `FINALIZADO (Atrasado ${pedido.diasDiferencaFinalizacao}d)`;
    return 'FINALIZADO (No prazo)';
  }
  if (classificacao.chave === 'vence-hoje') return 'VENCE HOJE';
  if (classificacao.chave === 'marrom' || classificacao.chave === 'roxo') {
    return `PEDIDO ATRASADO (${classificacao.diasAtraso}d)`;
  }
  if (classificacao.diasRestantes === 1) return 'Vence em 1 dia';
  return `Vence em ${classificacao.diasRestantes} dias`;
}

/* =========================================================================
   5. INTEGRAÇÃO COM O FIREBASE (AUTHENTICATION + FIRESTORE)
   -------------------------------------------------------------------------
   Usa autenticação anônima apenas para autorizar o acesso ao Firestore
   (não existe tela de login nem identificação de usuário no app).
   ========================================================================= */

// Carrega o Firebase (config + SDKs de Authentication e Firestore) usando
// import() DINÂMICO, e só então inicia a autenticação anônima e a escuta em
// tempo real. Qualquer falha nesta função - rede bloqueada, firewall
// corporativo, CDN inacessível, config inválida - é capturada aqui e não
// afeta o resto da interface (dark mode, modo celular, formulário), que já
// foi inicializada antes desta função ser chamada (ver seção 12).
async function carregarFirebaseEIniciar() {
  atualizarIndicadorSincronizacao('conectando');

  try {
    const [configModule, appModule, authModule, firestoreModule] = await Promise.all([
      import('./firebase-config.js'),
      import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js')
    ]);

    db = configModule.db;
    auth = configModule.auth;
    signInAnonymously = authModule.signInAnonymously;
    onAuthStateChanged = authModule.onAuthStateChanged;

    collection = firestoreModule.collection;
    addDoc = firestoreModule.addDoc;
    updateDoc = firestoreModule.updateDoc;
    deleteDoc = firestoreModule.deleteDoc;
    doc = firestoreModule.doc;
    onSnapshot = firestoreModule.onSnapshot;
    serverTimestamp = firestoreModule.serverTimestamp;
    query = firestoreModule.query;
    orderBy = firestoreModule.orderBy;

    colecaoPedidos = collection(db, NOME_COLECAO);

    iniciarAutenticacaoEDados();
  } catch (erro) {
    const mensagem =
      'Não foi possível carregar o Firebase. Verifique sua conexão de rede (o site precisa ' +
      'acessar www.gstatic.com e googleapis.com - firewalls corporativos, bloqueadores de ' +
      'anúncios ou redes restritas podem impedir isso) e se o arquivo firebase-config.js foi ' +
      'enviado ao repositório. Detalhe: ' + erro.message;
    exibirStatusConexao(mensagem, true);
    atualizarIndicadorSincronizacao('erro', 'Não foi possível carregar o Firebase');
  }
}

function iniciarAutenticacaoEDados() {
  onAuthStateChanged(auth, (usuario) => {
    if (usuario) {
      escutarPedidosEmTempoReal();
    }
  });

  signInAnonymously(auth).catch((erro) => {
    const mensagem =
      'Falha na autenticação. Verifique se o método de login "Anônimo" está ativado em ' +
      'Authentication > Sign-in method no console do Firebase. Detalhe: ' + erro.message;
    exibirStatusConexao(mensagem, true);
    atualizarIndicadorSincronizacao('erro', 'Não conectado (autenticação)');
  });
}

function escutarPedidosEmTempoReal() {
  const consulta = query(colecaoPedidos, orderBy('dataVencimento', 'asc'));
  onSnapshot(
    consulta,
    (snapshot) => {
      estado.pedidos = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      renderizarTudo();
      ocultarStatusConexao();
      atualizarIndicadorSincronizacao('ok');
    },
    (erro) => {
      const mensagem =
        'Erro ao sincronizar dados em tempo real. Verifique se as regras de firestore.rules ' +
        'foram publicadas no console do Firebase (aba Regras). Detalhe: ' + erro.message;
      exibirStatusConexao(mensagem, true);
      atualizarIndicadorSincronizacao('erro', 'Erro de permissão/regras');
    }
  );
}

// Atualiza a "bolinha" de status no cabeçalho: cinza (conectando), verde
// (sincronizado em tempo real) ou vermelho (erro, com a causa mais provável).
function atualizarIndicadorSincronizacao(estadoConexao, mensagemErro) {
  const indicador = document.getElementById('indicadorSincronizacao');
  const texto = document.getElementById('textoSincronizacao');
  if (!indicador || !texto) return;

  indicador.classList.remove('ok', 'erro', 'conectando');
  indicador.classList.add(estadoConexao);

  if (estadoConexao === 'ok') {
    texto.textContent = 'Sincronizado em tempo real';
  } else if (estadoConexao === 'erro') {
    texto.textContent = mensagemErro || 'Erro de sincronização';
  } else {
    texto.textContent = 'Conectando...';
  }
}

/* =========================================================================
   6. OPERAÇÕES DE CRUD DOS PEDIDOS
   ========================================================================= */

async function salvarPedido(dadosFormulario, idExistente) {
  const dataVencimento = calcularDataVencimento(dadosFormulario.dataRecebimentoEstoque, dadosFormulario.slaDias);

  const dados = {
    numeroPedido: String(dadosFormulario.numeroPedido).trim(),
    cliente: String(dadosFormulario.cliente).trim(),
    dataPedido: dadosFormulario.dataPedido,
    dataRecebimentoEstoque: dadosFormulario.dataRecebimentoEstoque,
    slaDias: Number(dadosFormulario.slaDias),
    dataVencimento,
    observacao: String(dadosFormulario.observacao || '').trim()
  };

  if (idExistente) {
    await updateDoc(doc(db, NOME_COLECAO, idExistente), dados);
  } else {
    await addDoc(colecaoPedidos, {
      ...dados,
      status: 'aberto',
      criadoEm: serverTimestamp(),
      finalizadoEm: null,
      resultadoSLA: null,
      diasDiferencaFinalizacao: null,
      // Status de separação (operacional): todo pedido novo começa "a separar".
      statusSeparacao: 'a-separar',
      operadorInicioSeparacao: null,
      dataHoraInicioSeparacao: null,
      operadorFimSeparacao: null,
      dataHoraFimSeparacao: null
    });
  }
}

// Localiza um pedido pelo número (comparação sem diferenciar maiúsculas ou
// espaços nas pontas), usado pelo painel de Registro de Separação.
function buscarPedidoPorNumero(numero) {
  const alvo = String(numero).trim().toLowerCase();
  return estado.pedidos.find((pedido) => String(pedido.numeroPedido).trim().toLowerCase() === alvo) || null;
}

async function iniciarSeparacaoPedido(pedido, nomeOperador) {
  await updateDoc(doc(db, NOME_COLECAO, pedido.id), {
    statusSeparacao: 'em-separacao',
    operadorInicioSeparacao: nomeOperador,
    dataHoraInicioSeparacao: serverTimestamp()
  });
}

async function finalizarSeparacaoPedido(pedido, nomeOperador) {
  await updateDoc(doc(db, NOME_COLECAO, pedido.id), {
    statusSeparacao: 'separado',
    operadorFimSeparacao: nomeOperador,
    dataHoraFimSeparacao: serverTimestamp()
  });
}

async function finalizarPedido(pedido) {
  const hoje = hojeISO();
  const { resultadoSLA, diasDiferencaFinalizacao } = calcularResultadoFinalizacao(pedido, hoje);
  await updateDoc(doc(db, NOME_COLECAO, pedido.id), {
    status: 'finalizado',
    finalizadoEm: serverTimestamp(),
    resultadoSLA,
    diasDiferencaFinalizacao
  });
}

async function reabrirPedido(pedido) {
  await updateDoc(doc(db, NOME_COLECAO, pedido.id), {
    status: 'aberto',
    finalizadoEm: null,
    resultadoSLA: null,
    diasDiferencaFinalizacao: null
  });
}

async function excluirPedido(id) {
  await deleteDoc(doc(db, NOME_COLECAO, id));
}

/* =========================================================================
   7. RENDERIZAÇÃO DE INTERFACE
   ========================================================================= */

// Ponto único de atualização: recalcula classificações e redesenha tudo.
function renderizarTudo() {
  const pedidosClassificados = estado.pedidos.map((pedido) => ({
    ...pedido,
    _classificacao: classificarPedido(pedido)
  }));

  renderizarDashboard(pedidosClassificados);
  renderizarPainelConsolidado(pedidosClassificados);
  renderizarTabelaPedidos(pedidosClassificados);
  renderizarHistorico();
  renderizarFaixaAeroporto(pedidosClassificados);
}

function renderizarDashboard(lista) {
  const abertos = lista.filter((p) => p.status === 'aberto');
  const noPrazo = abertos.filter((p) => ['verde', 'amarelo'].includes(p._classificacao.chave)).length;
  const venceHoje = abertos.filter((p) => p._classificacao.chave === 'vence-hoje').length;
  const atrasados = abertos.filter((p) => ['marrom', 'roxo'].includes(p._classificacao.chave)).length;

  const hoje = hojeISO();
  const finalizadosHoje = lista.filter(
    (p) => p.status === 'finalizado' && timestampParaISO(p.finalizadoEm) === hoje
  ).length;

  const totalPedidos = lista.length;
  const totalFinalizados = lista.filter((p) => p.status === 'finalizado').length;
  const taxaConclusao = totalPedidos > 0 ? Math.round((totalFinalizados / totalPedidos) * 100) : 0;

  document.getElementById('indTotalAberto').textContent = abertos.length;
  document.getElementById('indNoPrazo').textContent = noPrazo;
  document.getElementById('indVenceHoje').textContent = venceHoje;
  document.getElementById('indAtrasados').textContent = atrasados;
  document.getElementById('indFinalizadosHoje').textContent = finalizadosHoje;
  document.getElementById('indTaxaConclusao').textContent = `${taxaConclusao}%`;
}

function renderizarPainelConsolidado(lista) {
  const abertos = lista.filter((p) => p.status === 'aberto');
  const grupos = new Map();

  abertos.forEach((pedido) => {
    const classificacao = pedido._classificacao;
    let chaveGrupo;
    let label;
    let ordem;

    let corClasse;
    if (classificacao.diasRestantes < 0) {
      // O grupo "atrasados" reúne marrom + roxo; usa a cor mais crítica (roxo).
      chaveGrupo = 'atrasados';
      label = 'PEDIDOS ATRASADOS';
      ordem = -2;
      corClasse = 'roxo';
    } else if (classificacao.diasRestantes === 0) {
      chaveGrupo = 'vence-hoje';
      label = 'VENCE HOJE';
      ordem = -1;
      corClasse = 'vence-hoje';
    } else {
      chaveGrupo = `dias-${classificacao.diasRestantes}`;
      label = `${classificacao.diasRestantes} DIA${classificacao.diasRestantes > 1 ? 'S' : ''}`;
      ordem = classificacao.diasRestantes;
      corClasse = classificacao.chave;
    }

    if (!grupos.has(chaveGrupo)) {
      grupos.set(chaveGrupo, { label, ordem, corClasse, pedidos: [] });
    }
    grupos.get(chaveGrupo).pedidos.push(pedido);
  });

  const listaGrupos = Array.from(grupos.values()).sort((a, b) => a.ordem - b.ordem);
  const container = document.getElementById('gruposConsolidados');
  container.innerHTML = '';

  if (listaGrupos.length === 0) {
    container.innerHTML = '<p class="mensagem-vazia">Nenhum pedido em aberto no momento.</p>';
    return;
  }

  listaGrupos.forEach((grupo) => {
    const cores = CONFIG_SLA.cores[grupo.corClasse] || {};
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'grupo-consolidado';
    botao.style.backgroundColor = cores.bg || '';
    botao.style.color = cores.texto || '';
    botao.innerHTML = `<span class="grupo-quantidade">${grupo.pedidos.length}</span><span class="grupo-label">${grupo.label}</span>`;
    botao.addEventListener('click', () => abrirModalGrupo(grupo.label, grupo.pedidos));
    container.appendChild(botao);
  });
}

function pedidoPassaFiltros(pedido) {
  const filtros = estado.filtros;

  if (filtros.status && pedido.status !== filtros.status) return false;

  if (filtros.texto) {
    const alvo = filtros.texto.trim().toLowerCase();
    const textoPedido = `${pedido.numeroPedido} ${pedido.cliente}`.toLowerCase();
    if (!textoPedido.includes(alvo)) return false;
  }

  if (filtros.recebIni && pedido.dataRecebimentoEstoque < filtros.recebIni) return false;
  if (filtros.recebFim && pedido.dataRecebimentoEstoque > filtros.recebFim) return false;
  if (filtros.vencIni && pedido.dataVencimento < filtros.vencIni) return false;
  if (filtros.vencFim && pedido.dataVencimento > filtros.vencFim) return false;

  return true;
}

function renderizarTabelaPedidos(lista) {
  const filtrados = lista.filter(pedidoPassaFiltros);

  filtrados.sort((a, b) => {
    const ordemA = ordemCriticidade(a._classificacao);
    const ordemB = ordemCriticidade(b._classificacao);
    if (ordemA !== ordemB) return ordemA - ordemB;
    const diasA = a._classificacao.diasRestantes ?? 0;
    const diasB = b._classificacao.diasRestantes ?? 0;
    return diasA - diasB;
  });

  // Mantém as duas representações (tabela e cartões) sempre atualizadas;
  // qual delas fica visível é decidido puramente pelo CSS, conforme o
  // "modo celular" (ver seção 10 e o atributo data-visualizacao).
  const corpo = document.getElementById('corpoTabelaPedidos');
  corpo.innerHTML = '';
  filtrados.forEach((pedido) => corpo.appendChild(criarLinhaPedido(pedido)));

  const containerCards = document.getElementById('listaCardsPedidos');
  containerCards.innerHTML = '';
  filtrados.forEach((pedido) => containerCards.appendChild(criarCardPedido(pedido)));

  document.getElementById('contadorListaPedidos').textContent = `(${filtrados.length})`;
  document.getElementById('mensagemListaVazia').hidden = filtrados.length > 0;
}

// Cria o <span> de badge de situação, reaproveitado pela tabela e pelo cartão.
function criarBadgeSituacao(pedido, classificacao) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.style.backgroundColor = classificacao.bg;
  badge.style.color = classificacao.texto;
  badge.title = classificacao.label;
  badge.textContent = textoSituacao(pedido, classificacao);
  return badge;
}

// Cria o indicador de Status de Separação (bolinha colorida + rótulo),
// reaproveitado pela tabela e pelo cartão. Independente da Situação (SLA).
function criarBadgeStatusSeparacao(pedido) {
  const chave = pedido.statusSeparacao || 'a-separar';
  const info = CONFIG_SEPARACAO[chave] || CONFIG_SEPARACAO['a-separar'];

  const span = document.createElement('span');
  span.className = 'status-separacao';
  span.title = info.label;

  const bolinha = document.createElement('span');
  bolinha.className = 'status-separacao-bolinha';
  bolinha.style.backgroundColor = info.cor;
  span.appendChild(bolinha);

  span.appendChild(document.createTextNode(info.label));
  return span;
}

// Nome do operador a exibir: quem iniciou (enquanto em separação) ou quem
// finalizou (quando já separado). Vazio enquanto o pedido ainda não foi
// atribuído a ninguém ("a separar").
function obterOperadorAtual(pedido) {
  if (pedido.statusSeparacao === 'separado') return pedido.operadorFimSeparacao || '-';
  if (pedido.statusSeparacao === 'em-separacao') return pedido.operadorInicioSeparacao || '-';
  return '-';
}

// Cria o checkbox de conclusão, reaproveitado pela tabela e pelo cartão.
function criarCheckboxConclusao(pedido) {
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = pedido.status === 'finalizado';
  check.setAttribute('aria-label', `Marcar pedido ${pedido.numeroPedido} como concluído`);
  check.addEventListener('change', () => {
    if (check.checked) {
      finalizarPedido(pedido).catch((erro) => alert('Erro ao finalizar pedido: ' + erro.message));
    } else {
      reabrirPedido(pedido).catch((erro) => alert('Erro ao reabrir pedido: ' + erro.message));
    }
  });
  return check;
}

// Cria os botões Editar/Excluir dentro de um container, reaproveitado pela
// tabela e pelo cartão.
function criarBotoesAcoes(pedido, container) {
  const btnEditar = document.createElement('button');
  btnEditar.type = 'button';
  btnEditar.className = 'btn btn-link';
  btnEditar.textContent = 'Editar';
  btnEditar.disabled = pedido.status === 'finalizado';
  btnEditar.title = pedido.status === 'finalizado' ? 'Pedidos finalizados não podem ser editados' : 'Editar pedido';
  btnEditar.addEventListener('click', () => abrirModalEdicaoPedido(pedido));

  const btnExcluir = document.createElement('button');
  btnExcluir.type = 'button';
  btnExcluir.className = 'btn btn-link btn-link-perigo';
  btnExcluir.textContent = 'Excluir';
  btnExcluir.addEventListener('click', () => {
    if (confirm(`Confirma a exclusão do pedido ${pedido.numeroPedido}? Esta ação não pode ser desfeita.`)) {
      excluirPedido(pedido.id).catch((erro) => alert('Erro ao excluir pedido: ' + erro.message));
    }
  });

  container.appendChild(btnEditar);
  container.appendChild(btnExcluir);
}

function criarLinhaPedido(pedido) {
  const classificacao = pedido._classificacao;
  const tr = document.createElement('tr');
  tr.title =
    `Criado em: ${formatarDataHoraBR(pedido.criadoEm)}` +
    (pedido.finalizadoEm ? ` • Finalizado em: ${formatarDataHoraBR(pedido.finalizadoEm)}` : '') +
    (pedido.dataHoraInicioSeparacao
      ? ` • Separação iniciada por ${pedido.operadorInicioSeparacao} em ${formatarDataHoraBrasilia(pedido.dataHoraInicioSeparacao)} (horário de Brasília)`
      : '') +
    (pedido.dataHoraFimSeparacao
      ? ` • Separação finalizada por ${pedido.operadorFimSeparacao} em ${formatarDataHoraBrasilia(pedido.dataHoraFimSeparacao)} (horário de Brasília)`
      : '');

  const celulas = [
    pedido.numeroPedido,
    pedido.cliente,
    formatarBR(pedido.dataPedido),
    formatarBR(pedido.dataRecebimentoEstoque),
    pedido.slaDias,
    formatarBR(pedido.dataVencimento)
  ];
  celulas.forEach((valor) => {
    const td = document.createElement('td');
    td.textContent = valor;
    tr.appendChild(td);
  });

  const tdSituacao = document.createElement('td');
  tdSituacao.appendChild(criarBadgeSituacao(pedido, classificacao));
  tr.appendChild(tdSituacao);

  const tdStatus = document.createElement('td');
  tdStatus.appendChild(criarBadgeStatusSeparacao(pedido));
  tr.appendChild(tdStatus);

  const tdOperador = document.createElement('td');
  tdOperador.className = 'col-operador';
  tdOperador.textContent = obterOperadorAtual(pedido);
  tr.appendChild(tdOperador);

  const tdObs = document.createElement('td');
  tdObs.textContent = pedido.observacao || '-';
  tdObs.className = 'col-observacao';
  tr.appendChild(tdObs);

  const tdCheck = document.createElement('td');
  tdCheck.className = 'col-check';
  tdCheck.appendChild(criarCheckboxConclusao(pedido));
  tr.appendChild(tdCheck);

  const tdAcoes = document.createElement('td');
  tdAcoes.className = 'col-acoes';
  criarBotoesAcoes(pedido, tdAcoes);
  tr.appendChild(tdAcoes);

  return tr;
}

// Versão em cartão da mesma linha de pedido, usada no "modo celular".
function criarCardPedido(pedido) {
  const classificacao = pedido._classificacao;
  const card = document.createElement('div');
  card.className = 'card-pedido';
  card.title =
    `Criado em: ${formatarDataHoraBR(pedido.criadoEm)}` +
    (pedido.finalizadoEm ? ` • Finalizado em: ${formatarDataHoraBR(pedido.finalizadoEm)}` : '');

  const topo = document.createElement('div');
  topo.className = 'card-pedido-topo';
  const numero = document.createElement('span');
  numero.textContent = `Nº ${pedido.numeroPedido}`;
  topo.appendChild(numero);
  topo.appendChild(criarBadgeSituacao(pedido, classificacao));
  card.appendChild(topo);

  const cliente = document.createElement('div');
  cliente.className = 'card-pedido-cliente';
  cliente.textContent = pedido.cliente;
  card.appendChild(cliente);

  const linhaStatusSeparacao = document.createElement('div');
  linhaStatusSeparacao.className = 'card-pedido-status-separacao';
  linhaStatusSeparacao.appendChild(criarBadgeStatusSeparacao(pedido));
  const nomeOperador = obterOperadorAtual(pedido);
  if (nomeOperador !== '-') {
    const operadorSpan = document.createElement('span');
    operadorSpan.className = 'card-pedido-operador';
    operadorSpan.textContent = nomeOperador;
    linhaStatusSeparacao.appendChild(operadorSpan);
  }
  card.appendChild(linhaStatusSeparacao);

  const grid = document.createElement('div');
  grid.className = 'card-pedido-grid';
  grid.innerHTML = `
    <span>Pedido: ${formatarBR(pedido.dataPedido)}</span>
    <span>Recebimento: ${formatarBR(pedido.dataRecebimentoEstoque)}</span>
    <span>SLA: ${pedido.slaDias} dias úteis</span>
    <span>Vencimento: ${formatarBR(pedido.dataVencimento)}</span>
  `;
  card.appendChild(grid);

  if (pedido.observacao) {
    const obs = document.createElement('div');
    obs.className = 'card-pedido-obs';
    obs.textContent = pedido.observacao;
    card.appendChild(obs);
  }

  const rodape = document.createElement('div');
  rodape.className = 'card-pedido-rodape';

  const labelConcluir = document.createElement('label');
  labelConcluir.className = 'card-pedido-concluir';
  const check = criarCheckboxConclusao(pedido);
  labelConcluir.appendChild(check);
  labelConcluir.appendChild(document.createTextNode('Concluído'));
  rodape.appendChild(labelConcluir);

  const acoes = document.createElement('div');
  acoes.className = 'card-pedido-acoes';
  criarBotoesAcoes(pedido, acoes);
  rodape.appendChild(acoes);

  card.appendChild(rodape);

  return card;
}

/* -------------------------------------------------------------------------
   Histórico operacional + gráfico de barras empilhadas em SVG puro
   ------------------------------------------------------------------------- */

// Retorna a data (yyyy-mm-dd) usada para agrupar um pedido, conforme o
// tipo de agrupamento selecionado.
function obterDataBucket(pedido, tipoAgrupamento) {
  if (tipoAgrupamento === 'vencimento') return pedido.dataVencimento || null;
  if (tipoAgrupamento === 'finalizacao') return timestampParaISO(pedido.finalizadoEm);
  return pedido.dataRecebimentoEstoque || null; // padrão: recebimento
}

/**
 * Calcula o histórico dos últimos N dias para o agrupamento selecionado.
 * Cada linha representa uma data e agrega os pedidos cujo campo de data
 * correspondente ao agrupamento caia naquele dia:
 *   - recebidos: total de pedidos do grupo (volume do dia)
 *   - finalizados: quantos, dentro do grupo, já estão concluídos
 *   - pendentes: quantos, dentro do grupo, ainda estão em aberto
 *   - atrasados: dentre os pendentes, quantos estão atualmente atrasados
 *   - percentualConclusao: finalizados / total do grupo
 */
function calcularHistorico(tipoAgrupamento, diasJanela = 14) {
  const hoje = parseDataLocal(hojeISO());
  const datasJanela = [];
  for (let i = diasJanela - 1; i >= 0; i--) {
    const data = new Date(hoje);
    data.setDate(data.getDate() - i);
    datasJanela.push(formatarISO(data));
  }

  return datasJanela.map((data) => {
    const grupo = estado.pedidos.filter((pedido) => obterDataBucket(pedido, tipoAgrupamento) === data);
    const finalizados = grupo.filter((pedido) => pedido.status === 'finalizado').length;
    const pendentes = grupo.filter((pedido) => pedido.status === 'aberto').length;
    const atrasados = grupo.filter(
      (pedido) => pedido.status === 'aberto' && diferencaEmDiasUteis(hojeISO(), pedido.dataVencimento) < 0
    ).length;
    const total = grupo.length;
    const percentualConclusao = total > 0 ? Math.round((finalizados / total) * 100) : 0;

    return { data, recebidos: total, finalizados, pendentes, atrasados, percentualConclusao };
  });
}

function renderizarHistorico() {
  const dados = calcularHistorico(estado.agrupamentoHistorico, 14);

  const corpo = document.getElementById('corpoTabelaHistorico');
  corpo.innerHTML = '';
  dados.forEach((linha) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatarBR(linha.data)}</td>
      <td>${linha.recebidos}</td>
      <td>${linha.finalizados}</td>
      <td>${linha.pendentes}</td>
      <td>${linha.atrasados}</td>
      <td>${linha.percentualConclusao}%</td>
    `;
    corpo.appendChild(tr);
  });

  renderizarGraficoSvg(dados);
}

// Lê o valor atual de uma variável CSS (para o gráfico acompanhar o tema).
function obterCorCss(nomeVariavel) {
  const valor = getComputedStyle(document.documentElement).getPropertyValue(nomeVariavel);
  return valor ? valor.trim() : '#999999';
}

function renderizarGraficoSvg(dados) {
  const container = document.getElementById('graficoHistoricoSvgContainer');
  container.innerHTML = '';

  const svgNS = 'http://www.w3.org/2000/svg';
  const larguraBarra = 22;
  const alturaTotal = 240;
  const margemInferior = 34;
  const margemSuperior = 10;
  const alturaUtil = alturaTotal - margemInferior - margemSuperior;
  const larguraTotal = Math.max(620, dados.length * 44);
  const espacamento = (larguraTotal - dados.length * larguraBarra) / (dados.length + 1);

  const maiorTotal = Math.max(1, ...dados.map((linha) => linha.recebidos));

  const corFinalizado = obterCorCss('--cor-grafico-finalizado');
  const corPendente = obterCorCss('--cor-grafico-pendente');
  const corAtrasado = obterCorCss('--cor-grafico-atrasado');

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${larguraTotal} ${alturaTotal}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', alturaTotal);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  dados.forEach((linha, indice) => {
    const pendentesNoPrazo = Math.max(0, linha.pendentes - linha.atrasados);
    const segmentos = [
      { valor: linha.finalizados, cor: corFinalizado, rotulo: 'Finalizados' },
      { valor: pendentesNoPrazo, cor: corPendente, rotulo: 'Pendentes' },
      { valor: linha.atrasados, cor: corAtrasado, rotulo: 'Atrasados' }
    ];

    const x = espacamento + indice * (larguraBarra + espacamento);
    let yAcumulado = alturaTotal - margemInferior;

    segmentos.forEach((segmento) => {
      const alturaSegmento = (segmento.valor / maiorTotal) * alturaUtil;
      if (alturaSegmento > 0) {
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', yAcumulado - alturaSegmento);
        rect.setAttribute('width', larguraBarra);
        rect.setAttribute('height', alturaSegmento);
        rect.setAttribute('fill', segmento.cor);
        rect.setAttribute('rx', '2');
        const titulo = document.createElementNS(svgNS, 'title');
        titulo.textContent = `${formatarBR(linha.data)} · ${segmento.rotulo}: ${segmento.valor}`;
        rect.appendChild(titulo);
        svg.appendChild(rect);
      }
      yAcumulado -= alturaSegmento;
    });

    const rotuloEixo = document.createElementNS(svgNS, 'text');
    rotuloEixo.setAttribute('x', x + larguraBarra / 2);
    rotuloEixo.setAttribute('y', alturaTotal - margemInferior + 16);
    rotuloEixo.setAttribute('text-anchor', 'middle');
    rotuloEixo.setAttribute('class', 'grafico-rotulo-eixo');
    rotuloEixo.textContent = formatarBR(linha.data).slice(0, 5);
    svg.appendChild(rotuloEixo);
  });

  container.appendChild(svg);

  const legenda = document.createElement('div');
  legenda.className = 'grafico-legenda';
  legenda.innerHTML = `
    <span><i class="legenda-cor" style="background:${corFinalizado}"></i>Finalizados</span>
    <span><i class="legenda-cor" style="background:${corPendente}"></i>Pendentes</span>
    <span><i class="legenda-cor" style="background:${corAtrasado}"></i>Atrasados</span>
  `;
  container.appendChild(legenda);
}

/* -------------------------------------------------------------------------
   Faixa fixa estilo painel de aeroporto
   ------------------------------------------------------------------------- */
function renderizarFaixaAeroporto(lista) {
  const abertos = lista.filter((pedido) => pedido.status === 'aberto');
  const atrasados = abertos.filter((pedido) => ['marrom', 'roxo'].includes(pedido._classificacao.chave)).length;
  const venceHoje = abertos.filter((pedido) => pedido._classificacao.chave === 'vence-hoje').length;

  const contagemPorDia = {};
  abertos.forEach((pedido) => {
    const dias = pedido._classificacao.diasRestantes;
    if (dias > 0) {
      contagemPorDia[dias] = (contagemPorDia[dias] || 0) + 1;
    }
  });

  const partes = [];
  partes.push(`${atrasados} PEDIDO${atrasados !== 1 ? 'S' : ''} ATRASADO${atrasados !== 1 ? 'S' : ''}`);
  partes.push(`${venceHoje} VENCE${venceHoje !== 1 ? 'M' : ''} HOJE`);

  Object.keys(contagemPorDia)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((dias) => {
      const quantidade = contagemPorDia[dias];
      partes.push(`${quantidade} VENCE${quantidade !== 1 ? 'M' : ''} EM ${dias} DIA${dias > 1 ? 'S' : ''}`);
    });

  const texto = partes.join('   |   ');

  montarTrilhoFaixaAeroporto(texto);

  // Cor geral do rodapé: marrom enquanto houver pedidos em aberto (fila com
  // trabalho pendente), verde quando não houver nenhum pedido em aberto.
  const rodape = document.getElementById('faixaAeroporto');
  if (rodape) {
    rodape.classList.remove('marrom', 'verde');
    rodape.classList.add(abertos.length > 0 ? 'marrom' : 'verde');
  }
}

// Preenche a faixa de rolagem com repetições do texto - o suficiente para
// que UM conjunto completo já cubra a largura da tela - e então duplica esse
// conjunto inteiro (para a animação de -50% ficar perfeitamente contínua,
// sem salto). Isso evita o problema de o texto ficar "preso" numa faixa
// estreita do lado esquerdo quando há poucos indicadores (texto curto).
// A velocidade é fixada em pixels por segundo, então a rolagem sempre
// parece igualmente rápida, independentemente do tamanho do texto.
const LARGURA_ESTIMADA_POR_CARACTERE_PX = 8.2; // fonte monoespaçada, ~0.85rem
const ESPACAMENTO_LATERAL_BLOCO_PX = 80; // deve acompanhar o padding definido em .faixa-aeroporto-conteudo no styles.css
const VELOCIDADE_ROLAGEM_PX_POR_SEGUNDO = 80;

function montarTrilhoFaixaAeroporto(texto) {
  const trilho = document.getElementById('trilhoFaixaAeroporto');
  if (!trilho) return;

  const larguraJanela = window.innerWidth || document.documentElement.clientWidth || 1200;
  const larguraBloco = (texto.length * LARGURA_ESTIMADA_POR_CARACTERE_PX) + ESPACAMENTO_LATERAL_BLOCO_PX;
  const repeticoesPorConjunto = Math.max(1, Math.ceil(larguraJanela / larguraBloco) + 1);

  trilho.innerHTML = '';
  let indiceGlobal = 0;
  for (let copia = 0; copia < 2; copia++) {
    for (let i = 0; i < repeticoesPorConjunto; i++) {
      const bloco = document.createElement('div');
      bloco.className = 'faixa-aeroporto-conteudo';
      bloco.textContent = texto;
      // Apenas o primeiro bloco é lido por leitores de tela; as repetições
      // seguintes existem só para preencher visualmente a rolagem.
      if (indiceGlobal > 0) bloco.setAttribute('aria-hidden', 'true');
      trilho.appendChild(bloco);
      indiceGlobal++;
    }
  }

  const larguraConjuntoEstimada = larguraBloco * repeticoesPorConjunto;
  const duracaoSegundos = Math.max(8, larguraConjuntoEstimada / VELOCIDADE_ROLAGEM_PX_POR_SEGUNDO);
  trilho.style.setProperty('--duracao-faixa-aeroporto', `${duracaoSegundos}s`);
}

/* =========================================================================
   8. MODAIS
   ========================================================================= */

// Abre o modal exclusivamente para EDITAR um pedido existente. A criação de
// novos pedidos é feita pelo formulário inline em "Adicionar Novo Pedido"
// (ver função configurarFormularioInlineNovoPedido), sem modal.
function abrirModalEdicaoPedido(pedido) {
  const form = document.getElementById('formPedido');
  form.reset();
  document.getElementById('erroFormPedido').hidden = true;

  document.getElementById('campoPedidoId').value = pedido.id;
  document.getElementById('campoNumeroPedido').value = pedido.numeroPedido;
  document.getElementById('campoCliente').value = pedido.cliente;
  document.getElementById('campoDataPedido').value = pedido.dataPedido;
  document.getElementById('campoDataRecebimento').value = pedido.dataRecebimentoEstoque;
  document.getElementById('campoSlaDias').value = pedido.slaDias;
  document.getElementById('campoObservacao').value = pedido.observacao || '';

  atualizarPreviewVencimento('campoDataRecebimento', 'campoSlaDias', 'previewVencimento');
  document.getElementById('modalPedido').hidden = false;
  document.getElementById('campoNumeroPedido').focus();
}

function fecharModalPedido() {
  document.getElementById('modalPedido').hidden = true;
}

// Atualiza o texto de preview do vencimento calculado. Recebe os IDs dos
// campos porque é reaproveitada tanto pelo modal de edição quanto pelo
// formulário inline de criação de pedidos.
function atualizarPreviewVencimento(idCampoRecebimento, idCampoSla, idPreview) {
  const recebimento = document.getElementById(idCampoRecebimento).value;
  const sla = Number(document.getElementById(idCampoSla).value);
  const preview = document.getElementById(idPreview);
  if (recebimento && sla > 0) {
    preview.textContent = formatarBR(calcularDataVencimento(recebimento, sla));
  } else {
    preview.textContent = '–';
  }
}

function abrirModalGrupo(titulo, pedidos) {
  document.getElementById('modalGrupoTitulo').textContent = titulo;
  const lista = document.getElementById('listaModalGrupo');
  lista.innerHTML = '';

  pedidos
    .slice()
    .sort((a, b) => (a._classificacao.diasRestantes ?? 0) - (b._classificacao.diasRestantes ?? 0))
    .forEach((pedido) => {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${pedido.numeroPedido}</strong> — ${pedido.cliente}
        <span class="lista-modal-venc">Vencimento: ${formatarBR(pedido.dataVencimento)}</span>`;
      lista.appendChild(li);
    });

  document.getElementById('modalGrupo').hidden = false;
}

function fecharModalGrupo() {
  document.getElementById('modalGrupo').hidden = true;
}

/* =========================================================================
   9. FILTROS, BUSCA E EVENTOS DE INTERFACE
   ========================================================================= */

function configurarModais() {
  document.getElementById('btnFecharModalPedido').addEventListener('click', fecharModalPedido);
  document.getElementById('btnCancelarPedido').addEventListener('click', fecharModalPedido);
  document.getElementById('modalPedido').addEventListener('click', (evento) => {
    if (evento.target.id === 'modalPedido') fecharModalPedido();
  });

  document.getElementById('btnFecharModalGrupo').addEventListener('click', fecharModalGrupo);
  document.getElementById('modalGrupo').addEventListener('click', (evento) => {
    if (evento.target.id === 'modalGrupo') fecharModalGrupo();
  });

  document.getElementById('campoDataRecebimento').addEventListener('input', () =>
    atualizarPreviewVencimento('campoDataRecebimento', 'campoSlaDias', 'previewVencimento')
  );
  document.getElementById('campoSlaDias').addEventListener('input', () =>
    atualizarPreviewVencimento('campoDataRecebimento', 'campoSlaDias', 'previewVencimento')
  );

  // Formulário do modal: usado exclusivamente para EDITAR um pedido existente.
  document.getElementById('formPedido').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const erro = document.getElementById('erroFormPedido');
    erro.hidden = true;

    const dados = {
      numeroPedido: document.getElementById('campoNumeroPedido').value,
      cliente: document.getElementById('campoCliente').value,
      dataPedido: document.getElementById('campoDataPedido').value,
      dataRecebimentoEstoque: document.getElementById('campoDataRecebimento').value,
      slaDias: document.getElementById('campoSlaDias').value,
      observacao: document.getElementById('campoObservacao').value
    };

    const invalido =
      !dados.numeroPedido.trim() ||
      !dados.cliente.trim() ||
      !dados.dataPedido ||
      !dados.dataRecebimentoEstoque ||
      !dados.slaDias ||
      Number(dados.slaDias) <= 0;

    if (invalido) {
      erro.textContent = 'Preencha todos os campos obrigatórios (marcados com *) com valores válidos.';
      erro.hidden = false;
      return;
    }

    const idExistente = document.getElementById('campoPedidoId').value || null;

    try {
      await salvarPedido(dados, idExistente);
      fecharModalPedido();
    } catch (erroSalvar) {
      erro.textContent = 'Erro ao salvar pedido: ' + erroSalvar.message;
      erro.hidden = false;
    }
  });
}

/**
 * Alterna entre as duas telas do app: "Painel Operacional" (tela inicial:
 * Painel Consolidado por Prazo, busca e Adicionar Pedido) e "Painel
 * Consolidado" (indicadores, tabela de pedidos e histórico/gráfico),
 * acessada pelo botão 📊 no cabeçalho.
 */
function configurarNavegacaoTelas() {
  const telaOperacional = document.getElementById('telaOperacional');
  const telaPainelConsolidado = document.getElementById('telaPainelConsolidado');
  const botaoCabecalho = document.getElementById('btnPainelConsolidado');
  const botaoVoltar = document.getElementById('btnVoltarOperacional');

  function mostrarPainelConsolidado() {
    telaOperacional.hidden = true;
    telaPainelConsolidado.hidden = false;
    botaoCabecalho.setAttribute('aria-pressed', 'true');
    botaoCabecalho.title = 'Voltar ao Painel Operacional';
  }

  function mostrarOperacional() {
    telaPainelConsolidado.hidden = true;
    telaOperacional.hidden = false;
    botaoCabecalho.setAttribute('aria-pressed', 'false');
    botaoCabecalho.title = 'Painel Consolidado (indicadores, pedidos e histórico)';
  }

  botaoCabecalho.addEventListener('click', () => {
    if (telaPainelConsolidado.hidden) mostrarPainelConsolidado();
    else mostrarOperacional();
  });

  if (botaoVoltar) botaoVoltar.addEventListener('click', mostrarOperacional);
}

/**
 * Modal "Registro de Separação": o operador informa o número do pedido e o
 * próprio nome, e escolhe iniciar ou finalizar a separação física do
 * pedido. A data/hora é gravada pelo servidor (serverTimestamp) e exibida
 * sempre no horário de Brasília, independentemente do relógio do operador.
 * Esse status é totalmente independente da Situação (SLA) e do checkbox
 * "Concluir".
 */
function configurarModalSeparacao() {
  const modal = document.getElementById('modalSeparacao');
  const campoNumero = document.getElementById('campoSeparacaoNumeroPedido');
  const campoOperador = document.getElementById('campoSeparacaoOperador');
  const erro = document.getElementById('erroFormSeparacao');
  const sucesso = document.getElementById('sucessoFormSeparacao');

  function abrirModal() {
    document.getElementById('formRegistroSeparacao').reset();
    erro.hidden = true;
    sucesso.hidden = true;
    modal.hidden = false;
    campoNumero.focus();
  }

  function fecharModal() {
    modal.hidden = true;
  }

  document.getElementById('btnRegistroSeparacao').addEventListener('click', abrirModal);
  document.getElementById('btnFecharModalSeparacao').addEventListener('click', fecharModal);
  modal.addEventListener('click', (evento) => {
    if (evento.target.id === 'modalSeparacao') fecharModal();
  });

  // Lê e valida os campos comuns às duas ações; retorna o pedido encontrado
  // e o nome do operador, ou null (já exibindo a mensagem de erro) se algo
  // estiver inválido.
  function lerELocalizarPedido() {
    erro.hidden = true;
    sucesso.hidden = true;

    const numero = campoNumero.value.trim();
    const nome = campoOperador.value.trim();

    if (!numero || !nome) {
      erro.textContent = 'Informe o número do pedido e o nome do operador.';
      erro.hidden = false;
      return null;
    }

    const pedido = buscarPedidoPorNumero(numero);
    if (!pedido) {
      erro.textContent = `Nenhum pedido encontrado com o número "${numero}".`;
      erro.hidden = false;
      return null;
    }

    return { pedido, nome };
  }

  document.getElementById('btnIniciarSeparacao').addEventListener('click', async () => {
    const dados = lerELocalizarPedido();
    if (!dados) return;
    const { pedido, nome } = dados;

    if (pedido.statusSeparacao === 'em-separacao') {
      erro.textContent = `O pedido ${pedido.numeroPedido} já está em separação, iniciada por ${pedido.operadorInicioSeparacao}.`;
      erro.hidden = false;
      return;
    }
    if (pedido.statusSeparacao === 'separado') {
      erro.textContent = `O pedido ${pedido.numeroPedido} já foi separado por ${pedido.operadorFimSeparacao}.`;
      erro.hidden = false;
      return;
    }

    try {
      await iniciarSeparacaoPedido(pedido, nome);
      sucesso.textContent = `Separação do pedido ${pedido.numeroPedido} iniciada por ${nome}.`;
      sucesso.hidden = false;
      campoNumero.value = '';
      campoNumero.focus();
    } catch (erroSalvar) {
      erro.textContent = 'Erro ao registrar início da separação: ' + erroSalvar.message;
      erro.hidden = false;
    }
  });

  document.getElementById('btnFinalizarSeparacao').addEventListener('click', async () => {
    const dados = lerELocalizarPedido();
    if (!dados) return;
    const { pedido, nome } = dados;

    if (pedido.statusSeparacao === 'a-separar' || !pedido.statusSeparacao) {
      erro.textContent = `O pedido ${pedido.numeroPedido} ainda não teve a separação iniciada.`;
      erro.hidden = false;
      return;
    }
    if (pedido.statusSeparacao === 'separado') {
      erro.textContent = `O pedido ${pedido.numeroPedido} já foi separado por ${pedido.operadorFimSeparacao}.`;
      erro.hidden = false;
      return;
    }

    try {
      await finalizarSeparacaoPedido(pedido, nome);
      sucesso.textContent = `Separação do pedido ${pedido.numeroPedido} finalizada por ${nome}.`;
      sucesso.hidden = false;
      campoNumero.value = '';
      campoNumero.focus();
    } catch (erroSalvar) {
      erro.textContent = 'Erro ao registrar finalização da separação: ' + erroSalvar.message;
      erro.hidden = false;
    }
  });
}

/**
 * Formulário inline de criação de pedidos ("Adicionar Novo Pedido"), sempre
 * visível na página - sem modal. Após adicionar com sucesso, o formulário é
 * limpo e o foco volta ao primeiro campo, para permitir lançamentos
 * consecutivos rápidos.
 */
function configurarFormularioInlineNovoPedido() {
  document.getElementById('inlineDataPedido').value = hojeISO();

  document.getElementById('inlineDataRecebimento').addEventListener('input', () =>
    atualizarPreviewVencimento('inlineDataRecebimento', 'inlineSlaDias', 'previewVencimentoInline')
  );
  document.getElementById('inlineSlaDias').addEventListener('input', () =>
    atualizarPreviewVencimento('inlineDataRecebimento', 'inlineSlaDias', 'previewVencimentoInline')
  );

  document.getElementById('formNovoPedidoInline').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const erro = document.getElementById('erroFormInline');
    erro.hidden = true;

    const dados = {
      numeroPedido: document.getElementById('inlineNumeroPedido').value,
      cliente: document.getElementById('inlineCliente').value,
      dataPedido: document.getElementById('inlineDataPedido').value,
      dataRecebimentoEstoque: document.getElementById('inlineDataRecebimento').value,
      slaDias: document.getElementById('inlineSlaDias').value,
      observacao: document.getElementById('inlineObservacao').value
    };

    const invalido =
      !dados.numeroPedido.trim() ||
      !dados.cliente.trim() ||
      !dados.dataPedido ||
      !dados.dataRecebimentoEstoque ||
      !dados.slaDias ||
      Number(dados.slaDias) <= 0;

    if (invalido) {
      erro.textContent = 'Preencha Nº Pedido, Cliente, Data do Pedido, Rec. Estoque e SLA com valores válidos.';
      erro.hidden = false;
      return;
    }

    try {
      await salvarPedido(dados, null);
      // Limpa os campos para o próximo lançamento, mantendo a Data do
      // Pedido preenchida com hoje (o caso mais comum).
      document.getElementById('inlineNumeroPedido').value = '';
      document.getElementById('inlineCliente').value = '';
      document.getElementById('inlineDataPedido').value = hojeISO();
      document.getElementById('inlineDataRecebimento').value = '';
      document.getElementById('inlineSlaDias').value = '';
      document.getElementById('inlineObservacao').value = '';
      atualizarPreviewVencimento('inlineDataRecebimento', 'inlineSlaDias', 'previewVencimentoInline');
      document.getElementById('inlineNumeroPedido').focus();
    } catch (erroSalvar) {
      erro.textContent = 'Erro ao adicionar pedido: ' + erroSalvar.message;
      erro.hidden = false;
    }
  });
}

function configurarFiltrosEBusca() {
  document.getElementById('campoBusca').addEventListener('input', (evento) => {
    estado.filtros.texto = evento.target.value;
    renderizarTudo();
  });

  document.getElementById('filtroStatus').addEventListener('change', (evento) => {
    estado.filtros.status = evento.target.value;
    renderizarTudo();
  });

  document.getElementById('filtroRecebimentoInicio').addEventListener('change', (evento) => {
    estado.filtros.recebIni = evento.target.value;
    renderizarTudo();
  });

  document.getElementById('filtroRecebimentoFim').addEventListener('change', (evento) => {
    estado.filtros.recebFim = evento.target.value;
    renderizarTudo();
  });

  document.getElementById('filtroVencimentoInicio').addEventListener('change', (evento) => {
    estado.filtros.vencIni = evento.target.value;
    renderizarTudo();
  });

  document.getElementById('filtroVencimentoFim').addEventListener('change', (evento) => {
    estado.filtros.vencFim = evento.target.value;
    renderizarTudo();
  });

  document.getElementById('btnLimparFiltros').addEventListener('click', () => {
    estado.filtros = { texto: '', status: '', recebIni: '', recebFim: '', vencIni: '', vencFim: '' };
    document.getElementById('campoBusca').value = '';
    document.getElementById('filtroStatus').value = '';
    document.getElementById('filtroRecebimentoInicio').value = '';
    document.getElementById('filtroRecebimentoFim').value = '';
    document.getElementById('filtroVencimentoInicio').value = '';
    document.getElementById('filtroVencimentoFim').value = '';
    renderizarTudo();
  });

  document.getElementById('agrupamentoHistorico').addEventListener('change', (evento) => {
    estado.agrupamentoHistorico = evento.target.value;
    renderizarHistorico();
  });
}

function exibirStatusConexao(mensagem, erro) {
  const el = document.getElementById('statusConexao');
  el.textContent = mensagem;
  el.hidden = false;
  el.className = 'status-conexao' + (erro ? ' status-conexao-erro' : '');
}

function ocultarStatusConexao() {
  document.getElementById('statusConexao').hidden = true;
}

/* =========================================================================
   10. TEMA CLARO/ESCURO (DARK MODE)
   ========================================================================= */
const CHAVE_TEMA = 'uniso_sla_tema';

function aplicarTema(tema) {
  document.documentElement.setAttribute('data-tema', tema);
  const botao = document.getElementById('btnDarkMode');
  if (botao) botao.textContent = tema === 'escuro' ? '☀️' : '🌙';
  // Recalcula o gráfico SVG para usar as cores corretas do novo tema.
  if (estado.pedidos.length >= 0) renderizarHistorico();
}

function inicializarTema() {
  let temaSalvo = null;
  try {
    temaSalvo = localStorage.getItem(CHAVE_TEMA);
  } catch (erro) {
    // Armazenamento local indisponível (ex.: navegação privada); ignora e segue com o padrão do sistema.
  }

  if (temaSalvo === 'claro' || temaSalvo === 'escuro') {
    aplicarTema(temaSalvo);
  } else {
    const prefereEscuro = window.matchMedia('(prefers-color-scheme: dark)').matches;
    aplicarTema(prefereEscuro ? 'escuro' : 'claro');
  }

  document.getElementById('btnDarkMode').addEventListener('click', () => {
    const atual = document.documentElement.getAttribute('data-tema');
    const novo = atual === 'escuro' ? 'claro' : 'escuro';
    aplicarTema(novo);
    try {
      localStorage.setItem(CHAVE_TEMA, novo);
    } catch (erro) {
      // Armazenamento local indisponível; a preferência não será persistida nesta sessão.
    }
  });
}

/* =========================================================================
   10-B. MODO CELULAR (alternância manual de visualização)
   -------------------------------------------------------------------------
   Botão independente do dark mode: força o layout compacto (e troca a
   tabela de pedidos por cartões empilhados) mesmo em uma tela grande,
   através do atributo data-visualizacao no elemento <html> (ver seção 15
   de styles.css). Diferente da responsividade automática (que já se
   adapta sozinha ao tamanho real da tela), este botão é uma escolha
   manual do usuário, persistida no navegador.
   ========================================================================= */
const CHAVE_VISUALIZACAO = 'uniso_sla_visualizacao';

function aplicarModoVisualizacao(modo) {
  document.documentElement.setAttribute('data-visualizacao', modo);
  const botao = document.getElementById('btnModoCelular');
  if (botao) {
    botao.textContent = modo === 'celular' ? '🖥️' : '📱';
    botao.title = modo === 'celular' ? 'Voltar para o modo desktop' : 'Alternar para modo celular';
    botao.setAttribute('aria-label', botao.title);
  }
}

function inicializarModoVisualizacao() {
  let modoSalvo = null;
  try {
    modoSalvo = localStorage.getItem(CHAVE_VISUALIZACAO);
  } catch (erro) {
    // Armazenamento local indisponível; assume o padrão (desktop).
  }

  aplicarModoVisualizacao(modoSalvo === 'celular' ? 'celular' : 'desktop');

  document.getElementById('btnModoCelular').addEventListener('click', () => {
    const atual = document.documentElement.getAttribute('data-visualizacao');
    const novo = atual === 'celular' ? 'desktop' : 'celular';
    aplicarModoVisualizacao(novo);
    try {
      localStorage.setItem(CHAVE_VISUALIZACAO, novo);
    } catch (erro) {
      // Armazenamento local indisponível; a preferência não será persistida nesta sessão.
    }
  });
}

/* =========================================================================
   11. DADOS DE DEMONSTRAÇÃO (opcional, não executado automaticamente)
   -------------------------------------------------------------------------
   Esta função NÃO é chamada em lugar nenhum do carregamento automático do
   sistema. Ela existe apenas para facilitar testes/demonstrações e pode
   ser removida deste arquivo sem qualquer impacto no funcionamento do app.

   Para usar: com o app aberto no navegador (F12 > Console), execute:
     carregarPedidosDemonstracao()
   Os pedidos criados ficam marcados com "DEMO-" no número do pedido para
   facilitar a exclusão manual posterior.
   ========================================================================= */
async function carregarPedidosDemonstracao() {
  const hoje = hojeISO();
  const exemplos = [
    {
      numeroPedido: 'DEMO-001',
      cliente: 'Cliente Exemplo A',
      dataPedido: hoje,
      dataRecebimentoEstoque: hoje,
      slaDias: 5,
      observacao: 'Pedido de demonstração (dentro do prazo).'
    },
    {
      numeroPedido: 'DEMO-002',
      cliente: 'Cliente Exemplo B',
      dataPedido: hoje,
      dataRecebimentoEstoque: somarDiasUteis(hoje, -6),
      slaDias: 5,
      observacao: 'Pedido de demonstração (atrasado).'
    },
    {
      numeroPedido: 'DEMO-003',
      cliente: 'Cliente Exemplo C',
      dataPedido: hoje,
      dataRecebimentoEstoque: somarDiasUteis(hoje, -4),
      slaDias: 4,
      observacao: 'Pedido de demonstração (vence hoje).'
    }
  ];

  for (const exemplo of exemplos) {
    await salvarPedido(exemplo, null);
  }
  console.info('Pedidos de demonstração criados com sucesso. Exclua-os antes de usar o sistema em produção.');
}
window.carregarPedidosDemonstracao = carregarPedidosDemonstracao;

/* =========================================================================
   12. INICIALIZAÇÃO DA APLICAÇÃO
   -------------------------------------------------------------------------
   A configuração de interface (tema, modo celular, formulário, filtros e a
   primeira renderização) é executada de forma incondicional e SÍNCRONA,
   antes de qualquer tentativa de carregar o Firebase. Assim, mesmo que o
   carregamento do Firebase falhe (rede bloqueada, firewall, config
   inválida), o dark mode, o modo celular e a validação do formulário
   continuam funcionando normalmente. O carregamento do Firebase é feito
   por último, de forma assíncrona e isolada, em carregarFirebaseEIniciar().
   ========================================================================= */
inicializarTema();
inicializarModoVisualizacao();
configurarNavegacaoTelas();
configurarModais();
configurarModalSeparacao();
configurarFormularioInlineNovoPedido();
configurarFiltrosEBusca();
renderizarTudo();
carregarFirebaseEIniciar();
