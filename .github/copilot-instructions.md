# Copilot Instructions for FactoryIQ

Welcome to the FactoryIQ codebase! This document provides essential guidelines for AI coding agents to be productive in this project. It covers the architecture, workflows, and conventions specific to this repository.

---

## Project Overview

FactoryIQ is a system with both backend and frontend components:

### Backend
- **Framework**: Python with FastAPI.
- **Location**: `backend/app/`
- **Setup**:
  1. Navigate to the `backend` directory.
  2. Create a virtual environment: `python -m venv venv`
  3. Activate the virtual environment: `venv\Scripts\activate`
  4. Install dependencies: `pip install -r requirements.txt`
  5. Run the development server: `uvicorn app.main:app --reload`

### Frontend
- **Framework**: React with TypeScript and Vite.
- **Location**: `frontend/FactoryIQ-UI/`
- **Setup**:
  1. Navigate to the `frontend` directory.
  2. Install dependencies: `npm install`
  3. Start the development server: `npm run dev`

---

## Key Conventions

### Backend
- **Configuration**: Managed in `backend/app/config.py`. Ensure sensitive data is handled securely.
- **Database**: Interactions are defined in `backend/app/db.py`. Follow existing patterns for database queries.
- **Logging**: Logs are stored in `backend/backend.out.log` and `backend/backend.err.log`. Use structured logging for consistency.

### Frontend
- **Linting**: ESLint is configured. For stricter rules, expand the configuration as described in `frontend/FactoryIQ-UI/README.md`.
- **Styling**: Follow the React + TypeScript + Vite conventions. Use type-aware lint rules for better code quality.

---

## Developer Workflows

### Running the Full System
1. Start the backend server as described above.
2. Start the frontend server as described above.
3. Ensure all services are running by checking the logs in the `logs/` directory.

### Debugging
- **Backend**: Use FastAPI's interactive Swagger UI at `http://127.0.0.1:8000/docs`.
- **Frontend**: Use browser developer tools and Vite's HMR (Hot Module Replacement) for live debugging.

### Testing
- **Backend**: Add tests in `backend/tests/`. Use `pytest` for running tests.
- **Frontend**: Add tests in `frontend/FactoryIQ-UI/tests/`. Use `jest` and `react-testing-library`.

---

## Integration Points

- **Backend-Frontend Communication**: The frontend communicates with the backend via REST APIs. Ensure endpoints are documented in FastAPI's Swagger UI.
- **External Dependencies**: The backend uses Python packages listed in `requirements.txt`. The frontend uses npm packages listed in `package.json`.

---

## Examples

### Adding a New Backend Endpoint
1. Define the endpoint in `backend/app/main.py`.
2. Add the corresponding logic in a new or existing module in `backend/app/`.
3. Document the endpoint in the Swagger UI.

### Adding a New Frontend Component
1. Create the component in `frontend/FactoryIQ-UI/src/components/`.
2. Follow the existing TypeScript and React patterns.
3. Add tests for the component in `frontend/FactoryIQ-UI/tests/`.

---

For any questions or clarifications, refer to the `README.md` files in the respective directories or consult the project maintainers.