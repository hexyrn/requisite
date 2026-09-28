# Installing Requisite on Windows

Requisite runs on one Windows computer or server in your office. You install it with a normal Windows installer,
open it in your web browser, and sign in. Nothing else needs to be installed first, and there is nothing to
configure by hand.

## What you need

- Windows 10 (21H2 or later), Windows 11, or Windows Server 2019 / 2022 — 64-bit.
- An account with administrator rights on that computer (only for installing).
- 4 GB of memory and about 3 GB of free disk space, plus room for your data and backups.
- The file **`Requisite-Setup.exe`** from Hexyrn, and the **licence file** Hexyrn sends you after you tell them
  your Organisation ID (step 4 below).

## 1. Check the installer

Right-click `Requisite-Setup.exe` → **Properties** → **Digital Signatures**. The signer should be **Hexyrn**.
If Windows shows "Unknown publisher" or SmartScreen warns you, stop and contact Hexyrn — you may have been given a
test build that is not meant for customers.

## 2. Install

1. Double-click `Requisite-Setup.exe` and choose **Yes** when Windows asks for permission.
2. Click **Install** and wait a few minutes. The installer sets everything up, including Requisite's private
   database.
3. Setup checks that Requisite is running properly before it says it is finished. If Windows asks to restart, restart and setup carries on. If something goes wrong, setup undoes its changes and tells you where the log is; your data is never deleted by a failed install.
4. When it finishes, click **Launch**. Your web browser opens the Requisite setup page. (You can always open
   Requisite later from the Start menu: **Requisite**.)

Requisite starts automatically whenever the computer starts. Nobody needs to be signed in to Windows for it to run.

## 3. First-time setup (about a minute)

On the setup page enter:

- **Organisation name** — your company name.
- **Owner email** and **password** (at least 12 characters). The Owner has full control.

Click **Create organisation**. You are signed in automatically and taken to licence activation.
Regional settings (currency, time zone, financial year) are pre-filled from your computer; open
**Regional settings** on the same page if you want to change them.

## 4. Activate your licence

On the **Licence** page you will see your **Organisation ID**. Send it to Hexyrn; they reply with a small licence
file. Then click **Choose licence file…**, select the file, and Requisite is active — no internet connection is
needed for this. Click **Open Requisite**.

## 5. Turn on two-factor sign-in (strongly recommended)

Click your email address in the top bar → **Set up two-factor authentication**. Add the key shown to an
authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, …), type the 6-digit code, and
**save the recovery codes** somewhere safe — each works once if you lose your phone. Do this for every person,
especially the Owner.

## 6. Add your colleagues

**Administration → Users**. Enter their email, choose a role, and click **Create invitation**. Send them the link
that appears (it works once). They choose their own password.

Roles decide what people can do. Requisite comes with:

| Role                  | Intended for                                                  |
| --------------------- | ------------------------------------------------------------- |
| Owner                 | Full access, including Administration, licences and users     |
| Requisite - Requester | Raise and submit requisitions; view suppliers and orders      |
| Requisite - Approver  | Review and approve requisitions; view orders and reports      |
| Requisite - Buyer     | Manage suppliers, purchase orders, receipts, RFQs and reports |

A licence switches Requisite on for your organisation; it never gives anyone extra permissions. What a person
can do is decided only by their role.

## Backups and restoring

**Administration → Backup & Restore**

- **Backup Now** creates a complete backup (data and uploaded files). Backups are stored in
  `C:\ProgramData\Hexyrn Core\backups`.
- **Restore** puts a chosen backup back. This replaces the current data, so you are asked to confirm.
- Copy the `backups` folder to another disk or location regularly — a backup that only exists on the same
  computer will not help if that computer fails.

Backups are kept when you uninstall or reinstall Requisite.

## Updating to a new version

Run the new `Requisite-Setup.exe` and click **Install**. Your data, users, licence, settings and two-factor
setup are kept. Before anything changes, the installer takes a safety copy of your database
(`backups\pre-upgrade-<date>.dump`); if that copy cannot be made, the update stops and nothing is changed.

## Repairing

If something stops working, open **Settings → Apps → Requisite → Modify → Repair**. Repair restores program files
and services and never deletes data or changes your passwords and keys.

## Uninstalling

**Settings → Apps → Requisite → Uninstall.** Your data is **kept** in `C:\ProgramData\Hexyrn Core`, so installing
again later picks up exactly where you left off.

To remove the data as well (permanent, cannot be undone), run this from an administrator PowerShell:

```
& "C:\Program Files\Hexyrn Core\scripts\Remove-RequisiteData.ps1"
```

You must type `DELETE` to confirm.

## Letting other computers connect (optional)

By default Requisite can only be opened on the computer it is installed on
(`http://localhost:3000`), and no firewall port is opened. To let colleagues on your network use it, an
administrator runs, in an administrator PowerShell:

```
& "C:\Program Files\Hexyrn Core\scripts\Enable-LanAccess.ps1" -HostName requisite.yourcompany.local -CertificatePfx C:\path\to\certificate.pfx
```

- Use a certificate from your organisation's certificate authority (or a public one) for the name people will
  type. If you don't have one, use `-SelfSigned` instead; the script tells you which small certificate file to
  install on each computer that connects so browsers trust it.
- The script switches Requisite to HTTPS, opens one firewall port for your Domain/Private networks only, and
  restarts the service. The database stays private to this computer.
- To turn it off again: `Enable-LanAccess.ps1 -Disable`.

## Getting help

- **Administration → Health** shows whether everything is running.
- **Administration → Support Bundle**, or run
  `& "C:\Program Files\Hexyrn Core\scripts\Get-SupportBundle.ps1"` from an administrator PowerShell, creates a zip
  of logs and status for Hexyrn support. Passwords, keys and your data are not included.

| Problem                                           | What to do                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser says the page can't be reached        | Wait a minute after starting the computer, then try again. Open **Services** and check that **Requisite Database (PostgreSQL)** and **Requisite** are _Running_; start the database first, then Requisite. |
| The installer says another program uses port 3000 | Run `Requisite-Setup.exe HEXYRNWEBPORT=8080` from a Command Prompt (choose any free port).                                                                                                                 |
| Someone is locked out or forgot their password    | An administrator runs `& "C:\Program Files\Hexyrn Core\scripts\Reset-Password.ps1" -Email person@company.com` from an administrator PowerShell and types a new password.                                   |
| You lost your phone (two-factor)                  | Sign in with a recovery code, or ask an administrator to reset your two-factor sign-in.                                                                                                                    |

## Where things are

| What                     | Where                                                 |
| ------------------------ | ----------------------------------------------------- |
| Program                  | `C:\Program Files\Hexyrn Core`                        |
| Your data, backups, logs | `C:\ProgramData\Hexyrn Core` (`backups`, `logs`, …)   |
| Windows services         | **Requisite** and **Requisite Database (PostgreSQL)** |
| Start menu               | **Requisite**                                         |

For IT administrators: `Requisite-Setup.exe /quiet` installs silently (add `/log install.log` for a log).
