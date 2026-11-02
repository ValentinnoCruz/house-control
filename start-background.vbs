' House Control — Silent Windows Background Launcher
' Starts the House Control Govee LAN/Cloud backend + web UI in the background without a console window.
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
AppDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = AppDir

' Ensure Node.js path is included and start backend + dev server hidden (window style 0)
CmdBackend = "powershell.exe -NoProfile -WindowStyle Hidden -Command ""$env:PATH='C:\Users\Didis\AppData\Local\Programs\REA;' + $env:PATH; Set-Location '" & AppDir & "'; node server\index.mjs"""
CmdWeb = "powershell.exe -NoProfile -WindowStyle Hidden -Command ""$env:PATH='C:\Users\Didis\AppData\Local\Programs\REA;' + $env:PATH; Set-Location '" & AppDir & "\web'; npm run dev"""

WshShell.Run CmdBackend, 0, False
WshShell.Run CmdWeb, 0, False
