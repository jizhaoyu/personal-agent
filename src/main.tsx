import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App, { AppBoundary } from './App';
import { installAndroidBridge } from './services/androidBridge';

installAndroidBridge();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppBoundary><App /></AppBoundary>
  </React.StrictMode>
);
