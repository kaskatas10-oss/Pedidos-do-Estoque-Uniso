/**
 * firebase-config.js
 * -------------------------------------------------------------------------
 * Configuração e inicialização do Firebase (Authentication + Cloud Firestore)
 * para o sistema "Controle de SLA de Pedidos - UNISO".
 *
 * Preenchido com as credenciais do app Web do projeto "Controle de SLA de
 * Pedidos" (Firebase Console > Configurações do projeto > Geral > Seus apps).
 *
 * OBSERVAÇÃO SOBRE SEGURANÇA: a apiKey de um app Web do Firebase NÃO é um
 * segredo - ela é enviada ao navegador de qualquer visitante e, por design
 * do próprio Google, pode ficar visível no código-fonte do site. A proteção
 * real dos dados está nas regras do Firestore (firestore.rules), que já
 * bloqueiam qualquer acesso não autenticado. Como camada extra de segurança
 * (recomendado, especialmente se o repositório for público no GitHub),
 * restrinja esta chave por domínio em: Google Cloud Console > APIs e
 * serviços > Credenciais > selecione a chave > "Restrições de aplicativo" >
 * "Sites da Web" > adicione o domínio onde o app será publicado.
 *
 * SERVIÇOS QUE PRECISAM SER ATIVADOS NO CONSOLE (antes de usar o app):
 * - Authentication > Sign-in method > ative o provedor "Anônimo".
 *   (Usado apenas internamente para autorizar o acesso ao Firestore;
 *    não existe tela de login nem cadastro de usuários visível.)
 * - Firestore Database > Criar banco de dados > modo produção
 *   (as regras de segurança estão no arquivo firestore.rules).
 * -------------------------------------------------------------------------
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDtMAAfokE3Pti46tAGVW2XjAcVQLvxRco",
  authDomain: "controle-de-sla-de-pedidos.firebaseapp.com",
  projectId: "controle-de-sla-de-pedidos",
  storageBucket: "controle-de-sla-de-pedidos.firebasestorage.app",
  messagingSenderId: "610058416387",
  appId: "1:610058416387:web:ded5fdf9efcd7ae8b2f936"
  // measurementId omitido de propósito: este app não usa o Firebase Analytics.
};

// Inicialização dos serviços do Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db, signInAnonymously, onAuthStateChanged };
