import react from "@vitejs/plugin-react"; import tailwind from "@tailwindcss/vite"; import path from "path";
export default { base: "/manual/", plugins: [react(), tailwind()], resolve: { alias: { "@tanstack/react-router": path.resolve("src/stub.ts"), "@": path.resolve("src") } }, build: { outDir: "dist" } };
