import React, { useEffect, useState } from 'react';
import Home from './pages/Home.jsx';
import Jurado from './pages/Jurado.jsx';
import Publico from './pages/Publico.jsx';
import Auditor from './pages/Auditor.jsx';
import Coordinador from './pages/Coordinador.jsx';
import Operacion from './pages/Operacion.jsx';

// Tiny hash router: works on any static host without server configuration.
const ROUTES = {
  '': { label: 'Inicio', Page: Home },
  publico: { label: 'Resultados', Page: Publico },
  jurado: { label: 'Jurado', Page: Jurado },
  auditor: { label: 'Auditor', Page: Auditor },
  coordinador: { label: 'Coordinador', Page: Coordinador },
  operacion: { label: 'Operación', Page: Operacion },
};

const currentRoute = () => window.location.hash.replace(/^#\/?/, '').split('?')[0];

export default function App() {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const { Page } = ROUTES[route] || ROUTES[''];

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">Preconteo<span>en vivo</span></a>
        <nav>
          {Object.entries(ROUTES).filter(([k]) => k).map(([k, r]) => (
            <a key={k} href={`#/${k}`} className={route === k ? 'active' : ''}>{r.label}</a>
          ))}
        </nav>
      </header>
      <main className="container">
        <Page />
      </main>
      <footer className="footer">Preconteo informativo · El conteo oficial es el escrutinio de las actas físicas.</footer>
    </>
  );
}
