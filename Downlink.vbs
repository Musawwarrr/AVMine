' Starts Downlink without a persistent console window.
' If you need to stop it, use Task Manager or run run.bat instead.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c run.bat", 0, False
