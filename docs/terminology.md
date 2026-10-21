# App terms

Use the same term for the same item in the app documentation.
Product names, file names, command names, and UI labels keep their specified forms.

| Term | Meaning |
| --- | --- |
| practice preview | An incomplete remote service for development. It is not a public release. |
| account | A hosted identity for optional sign-in and purchase recovery. No account is necessary for local practice. |
| AI coach | The optional app component that sends practice text to a model and displays its response. |
| API key | A credential that permits requests to a service. |
| attempt | A coding practice record for one user and one content revision. |
| backend | The Python process that supplies practice tools with MCP. |
| checkpoint | A saved copy of design notes and diagram evidence that does not change after creation. |
| code editor | The Monaco component in the coding workspace. |
| coach turn | One user question, the model requests that follow it, and the tool results for those requests. |
| content pack | A signed file that contains questions for installation in a local workspace. |
| content revision | The specified version of a question that a practice record keeps. |
| curated hint | A hint from the question's stored text, without a model request. |
| design brief | A system-design question with requirements, constraints, and discussion topics. |
| design review | The report from the **Review** action. It identifies discussion coverage, not design correctness. |
| design session | A practice record for one user and one design brief. |
| draft | The user's saved code, or saved diagram and notes, before submission or completion. |
| evidence | Saved code, notes, or diagram data for a practice operation. Evidence is not proof that a solution is correct. |
| entitlement | A proposed hosted record that permits access to a purchased product. |
| fixture | A controlled test input or response. A model fixture does not do model inference. |
| installer | A package that installs the desktop app on the target operating system. |
| main process | The Electron process that controls files, credentials, MCP requests, and the app window. |
| MCP | Model Context Protocol, the interface between a client and tools from a server. |
| model | The local or remote language model that supplies coach responses and tool requests. |
| Piston | The optional local service that executes code in a container. |
| practice queue | The user's list of reminders for recall and reflection. |
| provider | The configured service that supplies a model or identifies an account user. The context identifies which service. |
| prompt | Instruction text that the app sends to a model. |
| reflection | The user's saved recall answer, self-rating, and next step. |
| release manifest | Signed metadata that identifies an app version and its installer files. |
| renderer | The Electron process that displays the React UI. It has no direct Node.js access. |
| sandbox | The local container environment for code execution. It is not a public multi-user execution service. |
| scaffold | The initial code file that contains a problem's function signature and incomplete body. |
| session token | A credential for an authenticated account session. It is not a practice record. |
| snapshot | A copy of app state or practice evidence at a specified time. The context identifies which copy. |
| tool | An MCP operation with named inputs and a result. |
| webhook | A notification that an external service sends to a configured HTTP endpoint. |
| whiteboard | The built-in Excalidraw canvas for system-design diagrams. |
| workspace | The local app data and practice records for one configured connection identity. |

AI means artificial intelligence. API means application programming interface.
UI means user interface. IPC means inter-process communication.
ID means identifier. PKCE means Proof Key for Code Exchange.

OS means operating system. HTTP means Hypertext Transfer Protocol.
HTTPS is HTTP with transport encryption. SQL is Structured Query Language.
The app uses SQLAlchemy with a SQLite database.
NSIS means Nullsoft Scriptable Install System, the Windows installer tool.
