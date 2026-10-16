import { createRoot } from "react-dom/client";
import "./styles.css";
import { Route } from "./routes/index";
const C = (Route as any).component;
createRoot(document.getElementById("root")!).render(<C />);
