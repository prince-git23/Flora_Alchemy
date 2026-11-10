import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { StoreProvider } from './context/StoreContext.jsx';
import { AdminSessionProvider } from './context/AdminSessionContext.jsx';
import { DataProvider } from './context/DataContext.jsx';
import SmoothScroll from './components/SmoothScroll.jsx';
import './index.css';

/* The boot skeleton in index.html is real DOM inside #root: it is what a visitor
   sees while this chunk downloads and the first hydration lands (measured on the
   deployed build: 169 KB gzip of entry JS + ~1.4 s for /products). Removing it in
   the same tick as the first render keeps the hand-off invisible — no flash of an
   empty root, and no second loading state competing with RouteBootstrapGate. */
document.getElementById('fa-boot')?.remove();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <DataProvider>
        <StoreProvider>
          <AdminSessionProvider>
            {/* Lenis sits OUTSIDE the routes: the storefront is one continuous
                place, and a smooth-scroll layer that unmounts on navigation
                would make every route change a scroll jump. It is inert under
                reduced motion and on touch, and it never owns the scroll
                position (see the module for why). */}
            <SmoothScroll />
            <App />
          </AdminSessionProvider>
        </StoreProvider>
      </DataProvider>
    </BrowserRouter>
  </React.StrictMode>
);
