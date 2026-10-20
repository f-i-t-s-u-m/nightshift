import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import "../workspace/monaco";
import { useMonacoTheme } from "../workspace/common";
import { Spinner } from "./TaskBits";

export default function SkillEditor({ path, value, onChange, onSave }: { path: string; value: string; onChange: (value: string) => void; onSave: () => void }) {
  const theme = useMonacoTheme();
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  }, [onSave]);
  return (
    <Editor
      path={path}
      language="markdown"
      value={value}
      theme={theme}
      onChange={(next) => onChange(next ?? "")}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current());
        editor.focus();
      }}
      loading={<Spinner label="Loading editor" />}
      options={{
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "off",
        wordWrap: "on",
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
        tabSize: 2,
        renderLineHighlight: "none",
      }}
    />
  );
}
