# 🍿 Pochoclo

> Extensión de Chrome para transcribir audio de pestañas con flujo batch y live, fallback automático e historial local.

[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-green.svg)](./LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-blue.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Estado](https://img.shields.io/badge/estado-activo-success.svg)](#)

## TL;DR

```bash
git clone https://github.com/Wmatias16/Pochoclo-extension.git
```

1. Abrí `chrome://extensions/`
2. Activá **Modo desarrollador**
3. Hacé click en **Cargar extensión sin empaquetar**
4. Seleccioná la carpeta del repo
5. Abrí el popup de **Pochoclo**, configurá al menos un provider y empezá a grabar

## ✨ Features

- Soporte multi-provider para transcripción: **OpenAI Whisper**, **Deepgram**, **AssemblyAI**, **Groq**, **Google Cloud Speech-to-Text** y **Whisper local** vía bridge HTTP.
- Transcripción **live por streaming** con **Deepgram WebSocket** y actualización casi en tiempo real en el popup.
- Fallback automático entre modos y providers:
  - live → batch cuando una sesión live no puede sostenerse
  - cadena de providers elegibles según prioridad, configuración y disponibilidad
- Captura persistente con **offscreen document**, para que la grabación siga aunque cierres el popup.
- Procesamiento por **chunks** con indicador de progreso de clips procesados.
- Historial local de transcripciones con vista de detalle, renombrado, copiado y eliminación.
- **Resúmenes automáticos con IA** desde la vista de detalle usando OpenAI.
- Conciencia de grabación: recordatorios nativos, auto-stop por inactividad, badge `REC` e indicador flotante en la pestaña grabada.
- Visualizador de audio, timer, controles de grabar / pausar / reiniciar y feedback de estado en tiempo real.
- Configuración por provider desde el popup: credenciales, modelos, endpoints y activación/desactivación individual.
- Auditoría básica del provider resuelto, intentos fallidos y contexto de fallback en el historial.
- Endurecimiento de seguridad en MV3:
  - **sin claves embebidas en el código**
  - **CSP explícita y restrictiva**
  - permisos de red acotados a endpoints necesarios

## 🔌 Proveedores soportados

| Provider | Modo | ¿Requiere API key? |
| --- | --- | --- |
| OpenAI Whisper | Batch | Sí |
| Deepgram | Batch + Live | Sí |
| AssemblyAI | Batch | Sí |
| Groq | Batch | Sí |
| Google Cloud Speech-to-Text | Batch | Sí |
| Whisper local | Batch | No* |

\* Whisper local requiere levantar un bridge HTTP local (por defecto `http://127.0.0.1:8765`).

## 🚀 Instalación

### Como extensión desempaquetada en Chrome

1. Cloná este repositorio.
2. Abrí `chrome://extensions/`.
3. Activá **Modo desarrollador**.
4. Hacé click en **Cargar extensión sin empaquetar**.
5. Seleccioná la carpeta del repo.

## ⚙️ Configuración

1. Hacé click en el ícono de la extensión.
2. Abrí **Configuración** desde el popup.
3. Elegí un **provider default global**.
4. Completá la configuración del provider que quieras usar:
   - API key, si corresponde
   - modelo
   - base URL / endpoint, si aplica
   - opciones específicas como polling o live
5. Guardá los cambios.

### Configuración por provider

- **OpenAI**: API key, modelo Whisper y modelo de resumen/traducción.
- **Deepgram**: API key, modelo y endpoint; el modo live depende de la configuración del provider.
- **AssemblyAI**: API key, modelo, base URL y parámetros de polling.
- **Groq**: API key, modelo y endpoint compatible con OpenAI-style API.
- **Google**: API key y modelo.
- **Whisper local**: base URL, health path y transcribe path del bridge local.

## 🧭 Uso

1. Abrí la pestaña cuyo audio querés transcribir.
2. Hacé click en el ícono de **Pochoclo**.
3. Presioná **Grabar**.
4. Durante la captura vas a ver:
   - estado de grabación
   - timer
   - visualizador de audio
   - texto parcial/final según el modo
   - progreso de procesamiento por chunks cuando aplica
5. Podés **pausar**, **reanudar** o **detener**.
6. Al finalizar, la transcripción se guarda automáticamente en el **historial**.
7. Desde el detalle podés **copiar**, **renombrar**, **eliminar** y **generar un resumen**.

## 🏗️ Arquitectura

Pochoclo está construido sobre **Chrome Extensions Manifest V3** y divide responsabilidades en cuatro piezas principales:

- **Background service worker (`background.js`)**: orquesta estado global, ciclo de vida de captura, selección/fallback de providers, progreso de transcripción, historial y resúmenes.
- **Offscreen document (`offscreen.html` + `offscreen.js`)**: mantiene viva la captura y el procesamiento de audio aunque el popup se cierre.
- **Popup (`popup.html` + `popup.js`)**: UI principal para grabar, ver progreso, administrar providers, revisar historial y generar resúmenes.
- **Content script (`content.js`)**: muestra el indicador flotante de grabación sobre la pestaña activa.

### Flujo general

1. El popup pide iniciar captura.
2. El background crea o reutiliza el offscreen document.
3. El offscreen captura audio de la pestaña y lo envía como stream live o chunks batch.
4. El background resuelve el provider activo, aplica fallback si hace falta y persiste resultados en `chrome.storage.local`.
5. El popup rehidrata estado, progreso y transcripción cuando se vuelve a abrir.

## 🧪 Tests

```bash
node --test tests/*.test.js
```

La suite cubre, entre otras cosas:

- seguridad del manifest
- registry y adapters de providers
- captura offscreen
- progreso de chunks
- flujo live de Deepgram
- awareness de grabación
- popup y UI de resumen
- persistencia de settings e historial

## 🤝 Contribuir

Las contribuciones son bienvenidas. Si querés colaborar:

1. Abrí un issue describiendo el problema o mejora.
2. Proponé cambios pequeños y bien acotados.
3. Mantené compatibilidad con **Chrome MV3**.
4. Sumá o actualizá tests cuando cambies comportamiento.
5. Evitá introducir permisos, dependencias o endpoints remotos sin justificación clara.

## 📄 Licencia

Este proyecto se distribuye bajo la licencia **MIT**. Ver [`LICENSE`](./LICENSE).
