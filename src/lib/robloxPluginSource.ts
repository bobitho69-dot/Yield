// Roblox Studio plugin (Luau) — served as a downloadable .lua file at GET /api/roblox/plugin.lua.
// {{APP_URL}} is replaced with env.APP_URL by the server before serving.
export const ROBLOX_PLUGIN_SOURCE = `-- Yield for Roblox Studio
--
-- This is a local, unpublished Roblox Studio plugin that connects Studio to
-- Yield (a free AI web app builder). You link it ONCE: generate a link code on
-- the Yield website and paste it in here. The plugin redeems the code for a
-- permanent link to your Yield account, and from then on every place you open in
-- Studio auto-syncs by its Roblox PlaceId -- there is nothing to pair per game
-- ever again. While a place is open it pulls AI-generated Luau scripts and map
-- layouts from your Yield session and applies them, and can push the place's
-- existing scripts back to Yield so the AI can see and edit them.
--
-- NOTE: a brand-new place that has never been saved or published has a PlaceId of
-- 0, and Yield syncs by PlaceId, so save/publish the place first -- the panel will
-- tell you when it is waiting on this.
--
-- INSTALL: save this file as a .lua file and drop it directly into your local
-- Roblox Studio Plugins folder (Studio loads any .lua file placed there as a
-- plugin the next time it starts, or immediately via Plugins > Manage Plugins
-- reload, no packaging into a .rbxm required):
--   Windows: %LOCALAPPDATA%\\Roblox\\Plugins
--   Mac:     ~/Documents/Roblox/Plugins
--
-- PERMISSIONS: the first time this plugin makes an HTTP request, Studio will show
-- a one-time popup asking whether to allow HTTP requests from this local/unpublished
-- plugin -- click Allow. The first time it writes a Script's Source, Studio may show
-- a one-time "Script Injection" permission popup -- click Allow there too. Both
-- prompts are expected and required for the plugin to function; if you accidentally
-- deny one, re-run the action (Sync now / Connect) to be asked again.

local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Workspace = game:GetService("Workspace")
local Lighting = game:GetService("Lighting")

local API_BASE = "{{APP_URL}}" .. "/api/roblox/plugin"

-- ============================================================
-- THEME
-- ============================================================

local THEME = {
	background = Color3.fromRGB(30, 30, 34),
	panel = Color3.fromRGB(40, 40, 46),
	panelAlt = Color3.fromRGB(48, 48, 55),
	accent = Color3.fromRGB(99, 102, 241),
	accentHover = Color3.fromRGB(129, 132, 255),
	text = Color3.fromRGB(235, 235, 240),
	mutedText = Color3.fromRGB(160, 160, 170),
	danger = Color3.fromRGB(240, 100, 100),
	border = Color3.fromRGB(58, 58, 66),
}

-- ============================================================
-- SMALL UTILITIES
-- ============================================================

-- Generic Instance factory: builds an Instance, applies properties, and parents it
-- last (parenting last avoids firing change events / layout work while the instance
-- is still being configured, which is the recommended Roblox pattern).
local function new(className, props)
	local inst = Instance.new(className)
	for key, value in pairs(props) do
		if key ~= "Parent" then
			inst[key] = value
		end
	end
	if props.Parent then
		inst.Parent = props.Parent
	end
	return inst
end

local function hexToColor3(hex, fallback)
	fallback = fallback or Color3.fromRGB(255, 255, 255)
	if type(hex) ~= "string" then
		return fallback
	end
	local clean = hex:gsub("#", "")
	if #clean < 6 then
		return fallback
	end
	local r = tonumber(clean:sub(1, 2), 16)
	local g = tonumber(clean:sub(3, 4), 16)
	local b = tonumber(clean:sub(5, 6), 16)
	if not (r and g and b) then
		return fallback
	end
	return Color3.fromRGB(r, g, b)
end

-- Reads x/y/z out of a decoded-JSON table that may come in as either an object
-- ({x=.., y=.., z=..}) or an array ({1, 2, 3}), since HttpService:JSONDecode turns
-- JSON arrays into 1-indexed Lua tables.
local function xyz(t, defX, defY, defZ)
	defX, defY, defZ = defX or 0, defY or 0, defZ or 0
	if type(t) ~= "table" then
		return defX, defY, defZ
	end
	local x = t.x
	local y = t.y
	local z = t.z
	if x == nil then x = t[1] end
	if y == nil then y = t[2] end
	if z == nil then z = t[3] end
	return x or defX, y or defY, z or defZ
end

-- Reads width/depth out of a baseplate size table, same object-or-array tolerance.
local function widthDepth(t, defW, defD)
	defW, defD = defW or 512, defD or 512
	if type(t) ~= "table" then
		return defW, defD
	end
	local w = t.width or t[1]
	local d = t.depth or t[2]
	return w or defW, d or defD
end

local MATERIAL_LOOKUP = {
	plastic = Enum.Material.Plastic,
	wood = Enum.Material.Wood,
	brick = Enum.Material.Brick,
	concrete = Enum.Material.Concrete,
	metal = Enum.Material.Metal,
	grass = Enum.Material.Grass,
	sand = Enum.Material.Sand,
	neon = Enum.Material.Neon,
	glass = Enum.Material.Glass,
	forcefield = Enum.Material.ForceField,
	ice = Enum.Material.Ice,
	fabric = Enum.Material.Fabric,
	cobblestone = Enum.Material.Cobblestone,
	diamondplate = Enum.Material.DiamondPlate,
	slate = Enum.Material.Slate,
	marble = Enum.Material.Marble,
	granite = Enum.Material.Granite,
	rock = Enum.Material.Rock,
	snow = Enum.Material.Snow,
	mud = Enum.Material.Mud,
	asphalt = Enum.Material.Asphalt,
}

local function materialFromName(name)
	if type(name) ~= "string" then
		return Enum.Material.Plastic
	end
	return MATERIAL_LOOKUP[name:lower()] or Enum.Material.Plastic
end

-- "StarterPlayerScripts" (and "StarterCharacterScripts") are not real services --
-- they're fixed-name children of the StarterPlayer service -- but Yield's op paths
-- use them as if they were top-level roots for convenience. This resolves either a
-- real service name (via GetService) or one of those known aliases.
local SERVICE_ALIASES = {
	StarterPlayerScripts = function()
		return game:GetService("StarterPlayer"):WaitForChild("StarterPlayerScripts")
	end,
	StarterCharacterScripts = function()
		return game:GetService("StarterPlayer"):WaitForChild("StarterCharacterScripts")
	end,
}

local function resolveServiceRoot(name)
	local alias = SERVICE_ALIASES[name]
	if alias then
		local ok, inst = pcall(alias)
		if ok then
			return inst
		end
		return nil
	end
	local ok, inst = pcall(function()
		return game:GetService(name)
	end)
	if ok then
		return inst
	end
	return nil
end

-- ============================================================
-- STATE
-- ============================================================

local token = nil
local robloxUsername = nil

local isSyncing = false
local autoSyncRunning = false
local activityLog = {} -- newest entry at index 1, formatted strings, capped at 20

-- ============================================================
-- HTTP
-- ============================================================

-- Every network call in this plugin goes through here. Returns (ok, decodedBodyOrErrorString).
-- Never throws -- callers only ever need to check the boolean.
local function apiRequest(method, path, bodyTable)
	local headers = {
		["Content-Type"] = "application/json",
	}
	if token then
		headers["Authorization"] = "Bearer " .. token
	end

	local requestOptions = {
		Url = API_BASE .. path,
		Method = method,
		Headers = headers,
	}

	if bodyTable ~= nil then
		local encodeOk, encoded = pcall(function()
			return HttpService:JSONEncode(bodyTable)
		end)
		if not encodeOk then
			return false, "Failed to encode request body: " .. tostring(encoded)
		end
		requestOptions.Body = encoded
	end

	local requestOk, response = pcall(function()
		return HttpService:RequestAsync(requestOptions)
	end)

	if not requestOk then
		return false, "HTTP request failed (allow the HTTP request permission prompt if Studio showed one, then try again): " .. tostring(response)
	end

	if not response.Success then
		local detail = response.Body
		if detail == nil or detail == "" then
			detail = response.StatusMessage
		end
		return false, ("HTTP %s: %s"):format(tostring(response.StatusCode), tostring(detail))
	end

	if response.Body == nil or response.Body == "" then
		return true, {}
	end

	local decodeOk, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodeOk then
		return false, "Failed to parse server response: " .. tostring(decoded)
	end

	return true, decoded
end

-- ============================================================
-- PATH RESOLUTION (service/folder/.../ScriptName)
-- ============================================================

local function splitPath(path)
	local segments = {}
	for segment in string.gmatch(path or "", "[^/]+") do
		table.insert(segments, segment)
	end
	return segments
end

-- Walks an existing path without creating anything. Returns the Instance, or nil if
-- any segment along the way is missing.
local function findExistingAtPath(path)
	local segments = splitPath(path)
	if #segments < 2 then
		return nil
	end
	local current = resolveServiceRoot(segments[1])
	for i = 2, #segments do
		if not current then
			return nil
		end
		current = current:FindFirstChild(segments[i])
	end
	return current
end

-- Resolves (creating Folders as needed) the parent container for a script path.
-- Returns parent, scriptName, errorString.
local function ensureContainerForScript(path)
	local segments = splitPath(path)
	if #segments < 2 then
		return nil, nil, "Invalid path (expected service/.../ScriptName): " .. tostring(path)
	end

	local serviceName = segments[1]
	local scriptName = segments[#segments]
	local parent = resolveServiceRoot(serviceName)
	if not parent then
		return nil, nil, "Unknown Roblox service: " .. tostring(serviceName)
	end

	for i = 2, #segments - 1 do
		local folderName = segments[i]
		local child = parent:FindFirstChild(folderName)
		if not child then
			child = new("Folder", { Name = folderName, Parent = parent })
		elseif not child:IsA("Folder") then
			return nil, nil, ("Path segment '%s' exists but is not a Folder"):format(folderName)
		end
		parent = child
	end

	return parent, scriptName, nil
end

-- ============================================================
-- ACTIVITY LOG (UI is wired up further down; these just mutate state + repaint)
-- ============================================================

local renderActivityLog -- forward declaration, assigned once the UI exists

local function logActivity(message)
	table.insert(activityLog, 1, os.date("%H:%M:%S") .. "  " .. tostring(message))
	while #activityLog > 20 do
		table.remove(activityLog)
	end
	if renderActivityLog then
		renderActivityLog()
	end
end

local function clearActivityLog()
	activityLog = {}
	if renderActivityLog then
		renderActivityLog()
	end
end

-- ============================================================
-- OP HANDLERS
-- ============================================================

local function applyUpsertScript(op)
	local parent, scriptName, err = ensureContainerForScript(op.path)
	if not parent then
		error(err or ("Could not resolve path: " .. tostring(op.path)))
	end

	local className = op.className
	if className ~= "Script" and className ~= "LocalScript" and className ~= "ModuleScript" then
		className = "Script"
	end

	ChangeHistoryService:SetWaypoint("Yield sync: " .. op.path)

	local existing = parent:FindFirstChild(scriptName)
	if existing and existing.ClassName ~= className then
		-- A class mismatch is normally safe to replace (e.g. a Script that should now
		-- be a LocalScript) -- EXCEPT when the existing instance is a Folder with its
		-- own children (almost always another script's container, e.g. this path's
		-- last segment happens to collide with an earlier Folder segment). Destroying
		-- that would silently wipe everything nested under it, so refuse instead.
		if existing:IsA("Folder") and #existing:GetChildren() > 0 then
			error(("Refusing to overwrite non-empty Folder '%s' at %s with a %s -- rename one of them"):format(scriptName, op.path, className))
		end
		existing:Destroy()
		existing = nil
	end
	if not existing then
		existing = new(className, { Name = scriptName, Parent = parent })
	end
	existing.Source = op.source or ""

	ChangeHistoryService:SetWaypoint("Yield sync: " .. op.path)
	logActivity(("Applied %s (%s)"):format(op.path, className))
end

local function applyDeleteScript(op)
	local inst = findExistingAtPath(op.path)
	if inst then
		ChangeHistoryService:SetWaypoint("Yield sync: delete " .. op.path)
		inst:Destroy()
		ChangeHistoryService:SetWaypoint("Yield sync: delete " .. op.path)
		logActivity("Deleted " .. op.path)
	else
		logActivity("Nothing to delete at " .. tostring(op.path))
	end
end

-- Shared by the insert_model op and build_map's "models" list. Loads the asset,
-- unwraps InsertService's wrapper Model, positions/rotates/scales it, and (if
-- tagAsMap) marks it so a later build_map with clear=true can clean it up.
local function insertModel(entry, tagAsMap)
	local assetId = tonumber(entry.assetId)
	if not assetId then
		error("invalid assetId: " .. tostring(entry.assetId))
	end

	local loadOk, container = pcall(function()
		return InsertService:LoadAsset(assetId)
	end)
	if not loadOk then
		error("LoadAsset(" .. tostring(assetId) .. ") failed: " .. tostring(container))
	end

	-- LoadAsset always returns a Model wrapping the real insertable as its first
	-- child; unwrap it and discard the wrapper.
	local children = container:GetChildren()
	local instanceToUse = container
	if #children > 0 then
		instanceToUse = children[1]
		instanceToUse.Parent = Workspace
		container:Destroy()
	else
		instanceToUse.Parent = Workspace
	end

	if entry.name and entry.name ~= "" then
		instanceToUse.Name = entry.name
	end

	local px, py, pz = xyz(entry.position, 0, 0, 0)
	local rx, ry, rz = xyz(entry.rotation, 0, 0, 0)
	local targetCFrame = CFrame.new(px, py, pz) * CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
	local scale = tonumber(entry.scale) or 1

	if instanceToUse:IsA("Model") then
		pcall(function()
			instanceToUse:PivotTo(targetCFrame)
		end)
		if scale ~= 1 then
			pcall(function()
				instanceToUse:ScaleTo(scale)
			end)
		end
	elseif instanceToUse:IsA("BasePart") then
		instanceToUse.CFrame = targetCFrame
		if scale ~= 1 then
			instanceToUse.Size = instanceToUse.Size * scale
		end
	end

	if tagAsMap then
		pcall(function()
			instanceToUse:SetAttribute("YieldMap", true)
		end)
	end

	return instanceToUse
end

local function applyInsertModel(op)
	local inst = insertModel(op, false)
	logActivity(("Inserted model '%s' (id %s)"):format(inst.Name, tostring(op.assetId)))
end

local function applyBuildMap(op)
	local spec = op.spec
	if type(spec) ~= "table" then
		error("build_map op is missing a spec")
	end

	ChangeHistoryService:SetWaypoint("Yield build map")

	if spec.clear then
		for _, child in ipairs(Workspace:GetChildren()) do
			local ok, tagged = pcall(function()
				return child:GetAttribute("YieldMap")
			end)
			if ok and tagged == true then
				child:Destroy()
			end
		end
	end

	if type(spec.baseplate) == "table" then
		local w, d = widthDepth(spec.baseplate.size, 512, 512)
		local baseplate = Workspace:FindFirstChild("Baseplate")
		if baseplate and not baseplate:IsA("BasePart") then
			baseplate:Destroy()
			baseplate = nil
		end
		if not baseplate then
			baseplate = new("Part", { Name = "Baseplate", Parent = Workspace })
		end
		baseplate.Anchored = true
		baseplate.Size = Vector3.new(w, 2, d)
		baseplate.CFrame = CFrame.new(0, -1, 0)
		baseplate.Material = materialFromName(spec.baseplate.material)
		baseplate.Color = hexToColor3(spec.baseplate.color, Color3.fromRGB(58, 125, 58))
		baseplate.TopSurface = Enum.SurfaceType.Smooth
		baseplate.BottomSurface = Enum.SurfaceType.Smooth
		baseplate:SetAttribute("YieldMap", true)
	end

	local partCount = 0
	if type(spec.parts) == "table" then
		for _, entry in ipairs(spec.parts) do
			local ok, err = pcall(function()
				local shape = tostring(entry.shape or "Block"):lower()
				local part
				if shape == "wedge" then
					part = Instance.new("WedgePart")
				else
					part = Instance.new("Part")
					if shape == "cylinder" then
						part.Shape = Enum.PartType.Cylinder
					elseif shape == "ball" or shape == "sphere" then
						part.Shape = Enum.PartType.Ball
					else
						part.Shape = Enum.PartType.Block
					end
				end

				local sx, sy, sz = xyz(entry.size, 4, 4, 4)
				local px, py, pz = xyz(entry.position, 0, 0, 0)
				local rx, ry, rz = xyz(entry.rotation, 0, 0, 0)

				part.Name = entry.name or "Part"
				part.Size = Vector3.new(sx, sy, sz)
				part.CFrame = CFrame.new(px, py, pz) * CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
				part.Color = hexToColor3(entry.color, Color3.fromRGB(163, 162, 165))
				part.Material = materialFromName(entry.material)
				part.Anchored = entry.anchored ~= false
				part.Transparency = entry.transparency or 0
				part:SetAttribute("YieldMap", true)
				part.Parent = Workspace
			end)
			if ok then
				partCount = partCount + 1
			else
				logActivity("Error building part: " .. tostring(err))
			end
		end
	end

	local modelCount = 0
	if type(spec.models) == "table" then
		for _, entry in ipairs(spec.models) do
			local ok, err = pcall(insertModel, entry, true)
			if ok then
				modelCount = modelCount + 1
			else
				logActivity("Error inserting model in map: " .. tostring(err))
			end
		end
	end

	if type(spec.lighting) == "table" then
		local lg = spec.lighting
		if lg.ambient ~= nil then
			Lighting.Ambient = hexToColor3(lg.ambient, Lighting.Ambient)
		end
		if lg.brightness ~= nil then
			Lighting.Brightness = lg.brightness
		end
		if lg.clockTime ~= nil then
			Lighting.ClockTime = lg.clockTime
		end
		if lg.fogEnd ~= nil then
			Lighting.FogEnd = lg.fogEnd
		end
	end

	ChangeHistoryService:SetWaypoint("Yield build map")
	logActivity(("Built map: %d parts, %d models"):format(partCount, modelCount))
end

-- ============================================================
-- SYNC (pull -> apply -> ack)
-- ============================================================

local setStatusLabel -- forward declaration, assigned once the UI exists

local function performSync()
	if isSyncing or not token then
		return
	end
	isSyncing = true

	-- Yield syncs whatever place is currently open, keyed by its Roblox PlaceId. A
	-- brand-new unsaved/unpublished place has PlaceId 0, which can't be synced --
	-- bail out gracefully (no error spam) and tell the user what to do.
	local placeId = tostring(game.PlaceId)
	local placeName = game.Name
	if game.PlaceId == 0 then
		if setStatusLabel then
			setStatusLabel("Open or publish this place first -- it needs a PlaceId to sync.")
		end
		isSyncing = false
		return
	end

	local pullOk, body = apiRequest(
		"GET",
		"/pull?placeId=" .. HttpService:UrlEncode(placeId) .. "&placeName=" .. HttpService:UrlEncode(placeName),
		nil
	)
	if not pullOk then
		logActivity("Sync failed: " .. tostring(body))
		if setStatusLabel then
			setStatusLabel("Connected - last sync failed, will retry")
		end
		isSyncing = false
		return
	end

	-- apiRequest returns (true, {}) for an empty body, but a literal JSON "null"
	-- response would decode to Lua nil -- guard before indexing it below.
	if type(body) ~= "table" then
		logActivity("Sync failed: unexpected empty response from Yield")
		if setStatusLabel then
			setStatusLabel("Connected - last sync failed, will retry")
		end
		isSyncing = false
		return
	end

	-- Prefer the project title the server maps this place to, otherwise just show
	-- the place's own name.
	local displayName = placeName
	if type(body.project) == "table" and body.project.title and body.project.title ~= "" then
		displayName = body.project.title
	end

	local ops = body.ops
	if type(ops) ~= "table" or #ops == 0 then
		if setStatusLabel then
			setStatusLabel(("Synced • %s"):format(displayName))
		end
		isSyncing = false
		return
	end

	local results = {}
	for _, op in ipairs(ops) do
		local opOk, opErr = pcall(function()
			if op.type == "upsert_script" then
				applyUpsertScript(op)
			elseif op.type == "delete_script" then
				applyDeleteScript(op)
			elseif op.type == "build_map" then
				applyBuildMap(op)
			elseif op.type == "insert_model" then
				applyInsertModel(op)
			else
				error("Unknown op type: " .. tostring(op.type))
			end
		end)

		if opOk then
			table.insert(results, { id = op.id, ok = true })
		else
			table.insert(results, { id = op.id, ok = false, detail = tostring(opErr) })
			logActivity(("Error (%s): %s"):format(tostring(op.type), tostring(opErr)))
		end
	end

	-- Always report back, even on partial failure -- the server needs to know which
	-- ops landed so it doesn't resend them forever.
	local ackOk, ackErr = apiRequest("POST", "/ack", {
		placeId = placeId,
		placeName = placeName,
		results = results,
	})
	if not ackOk then
		logActivity("Failed to report sync results to Yield: " .. tostring(ackErr))
	end

	if setStatusLabel then
		setStatusLabel(("Synced • %s"):format(displayName))
	end
	isSyncing = false
end

local function startAutoSyncLoop(widget)
	if autoSyncRunning then
		return
	end
	autoSyncRunning = true
	task.spawn(function()
		while autoSyncRunning and token and widget.Enabled do
			-- pcall-wrapped so ANY uncaught error inside performSync (not just the
			-- per-op pcalls it already has) can't kill this coroutine and leave
			-- autoSyncRunning stuck true forever (which would silently block every
			-- future "Sync now" / auto-sync attempt until Studio restarts).
			local ok, err = pcall(performSync)
			if not ok then
				isSyncing = false
				logActivity("Auto-sync error: " .. tostring(err))
			end
			task.wait(20)
		end
		autoSyncRunning = false
	end)
end

local function stopAutoSyncLoop()
	autoSyncRunning = false
end

-- ============================================================
-- PUSH SNAPSHOT (send existing scripts in the place up to Yield)
-- ============================================================

-- Matches Yield's VALID_ROOTS exactly (src/lib/roblox.ts) -- every service an AI
-- or manual edit is allowed to write a script into is also scanned here, so a
-- script placed under e.g. Workspace or Lighting doesn't silently never push back.
local PUSH_ROOTS = {
	"Workspace",
	"ServerScriptService",
	"ServerStorage",
	"ReplicatedStorage",
	"StarterPlayerScripts",
	"StarterGui",
	"StarterPack",
	"StarterCharacterScripts",
	"Lighting",
}

local SCRIPT_CLASS_NAMES = {
	Script = true,
	LocalScript = true,
	ModuleScript = true,
}

local MAX_PUSH_SCRIPTS = 300

local function pathForInstance(inst, rootName, rootInstance)
	local segments = {}
	local current = inst
	while current and current ~= rootInstance do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	return rootName .. "/" .. table.concat(segments, "/")
end

local function collectScriptsForPush()
	local scripts = {}
	local truncated = false

	for _, rootName in ipairs(PUSH_ROOTS) do
		local rootInstance = resolveServiceRoot(rootName)
		if rootInstance then
			for _, descendant in ipairs(rootInstance:GetDescendants()) do
				if #scripts >= MAX_PUSH_SCRIPTS then
					truncated = true
					break
				end
				if SCRIPT_CLASS_NAMES[descendant.ClassName] then
					local ok, source = pcall(function()
						return descendant.Source
					end)
					if ok then
						table.insert(scripts, {
							path = pathForInstance(descendant, rootName, rootInstance),
							className = descendant.ClassName,
							source = source,
						})
					end
				end
			end
		end
		if #scripts >= MAX_PUSH_SCRIPTS then
			truncated = true
			break
		end
	end

	return scripts, truncated
end

local function pushSnapshot()
	-- Same PlaceId 0 caveat as performSync: an unsaved/unpublished place has no id
	-- to key the snapshot to, so don't push -- just tell the user.
	if game.PlaceId == 0 then
		if setStatusLabel then
			setStatusLabel("Open or publish this place first -- it needs a PlaceId to sync.")
		end
		logActivity("Can't push yet: save or publish this place so it has a PlaceId.")
		return
	end

	local scripts, truncated = collectScriptsForPush()
	if truncated then
		logActivity("Warning: this place has more than " .. MAX_PUSH_SCRIPTS .. " scripts, only pushing the first " .. MAX_PUSH_SCRIPTS)
	end

	local ok, body = apiRequest("POST", "/snapshot", {
		scripts = scripts,
		placeId = tostring(game.PlaceId),
		placeName = game.Name,
	})

	if ok then
		logActivity(("Pushed %d scripts to Yield"):format(#scripts))
	else
		logActivity("Push failed: " .. tostring(body))
	end
end

-- ============================================================
-- UI
-- ============================================================

local toolbar = plugin:CreateToolbar("Yield")
local toggleButton = toolbar:CreateButton(
	"YieldToggle",
	"Open the Yield panel to sync AI-generated scripts and maps",
	"",
	"Yield"
)

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 400, 260, 300)
local widget = plugin:CreateDockWidgetPluginGui("YieldRobloxPanel", widgetInfo)
widget.Title = "Yield"
widget.Name = "YieldRobloxPanel"

local root = new("Frame", {
	BackgroundColor3 = THEME.background,
	BorderSizePixel = 0,
	Size = UDim2.fromScale(1, 1),
	Parent = widget,
})

-- ---------- Pairing page ----------

local pairingPage = new("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.fromScale(1, 1),
	Parent = root,
})

new("TextLabel", {
	Font = Enum.Font.GothamBold,
	Text = "Connect to Yield",
	TextSize = 18,
	TextColor3 = THEME.text,
	TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 14),
	Size = UDim2.new(1, -28, 0, 24),
	Parent = pairingPage,
})

new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "Generate an 8-character link code on the Yield website and paste it below. This links Studio to your Yield account one time -- after that, every place you open here auto-syncs on its own. You never need to pair per game again.",
	TextSize = 13,
	TextColor3 = THEME.mutedText,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 42),
	Size = UDim2.new(1, -28, 0, 72),
	Parent = pairingPage,
})

local codeBox = new("TextBox", {
	Font = Enum.Font.GothamBold,
	PlaceholderText = "ABCD1234",
	PlaceholderColor3 = THEME.mutedText,
	Text = "",
	TextSize = 16,
	TextColor3 = THEME.text,
	ClearTextOnFocus = false,
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 14, 0, 120),
	Size = UDim2.new(1, -28, 0, 36),
	Parent = pairingPage,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = codeBox })
new("UIStroke", { Color = THEME.border, Thickness = 1, Parent = codeBox })
new("UIPadding", {
	PaddingLeft = UDim.new(0, 10),
	PaddingRight = UDim.new(0, 10),
	Parent = codeBox,
})

local connectButton = new("TextButton", {
	Font = Enum.Font.GothamBold,
	Text = "Connect",
	TextSize = 15,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	BackgroundColor3 = THEME.accent,
	AutoButtonColor = true,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 14, 0, 164),
	Size = UDim2.new(1, -28, 0, 36),
	Parent = pairingPage,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = connectButton })

local pairStatusLabel = new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 208),
	Size = UDim2.new(1, -28, 0, 60),
	Parent = pairingPage,
})

-- ---------- Connected page ----------

local connectedPage = new("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.fromScale(1, 1),
	Visible = false,
	Parent = root,
})

new("TextLabel", {
	Font = Enum.Font.GothamBold,
	Text = "Connected to Yield",
	TextSize = 17,
	TextColor3 = THEME.text,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextTruncate = Enum.TextTruncate.AtEnd,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 10),
	Size = UDim2.new(1, -28, 0, 22),
	Parent = connectedPage,
})

local userLabel = new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "Connected",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextTruncate = Enum.TextTruncate.AtEnd,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 34),
	Size = UDim2.new(1, -28, 0, 16),
	Parent = connectedPage,
})

local statusLabel = new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "Waiting for first sync...",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 52),
	Size = UDim2.new(1, -28, 0, 30),
	Parent = connectedPage,
})

local actionsRow = new("Frame", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 86),
	Size = UDim2.new(1, -28, 0, 32),
	Parent = connectedPage,
})
new("UIListLayout", {
	FillDirection = Enum.FillDirection.Horizontal,
	Padding = UDim.new(0, 8),
	SortOrder = Enum.SortOrder.LayoutOrder,
	Parent = actionsRow,
})

local syncButton = new("TextButton", {
	Font = Enum.Font.GothamBold,
	Text = "Sync now",
	TextSize = 13,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	BackgroundColor3 = THEME.accent,
	BorderSizePixel = 0,
	Size = UDim2.new(0.55, -4, 1, 0),
	LayoutOrder = 1,
	Parent = actionsRow,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = syncButton })

local pushButton = new("TextButton", {
	Font = Enum.Font.GothamBold,
	Text = "Push code",
	TextSize = 13,
	TextColor3 = THEME.text,
	BackgroundColor3 = THEME.panelAlt,
	BorderSizePixel = 0,
	Size = UDim2.new(0.45, -4, 1, 0),
	LayoutOrder = 2,
	Parent = actionsRow,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = pushButton })

local disconnectButton = new("TextButton", {
	Font = Enum.Font.Gotham,
	Text = "Disconnect",
	TextSize = 12,
	TextColor3 = THEME.danger,
	BackgroundTransparency = 1,
	AutoButtonColor = false,
	Position = UDim2.new(0, 14, 0, 124),
	Size = UDim2.new(1, -28, 0, 18),
	Parent = connectedPage,
})

new("TextLabel", {
	Font = Enum.Font.GothamBold,
	Text = "Activity",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 150),
	Size = UDim2.new(1, -28, 0, 16),
	Parent = connectedPage,
})

local logScroll = new("ScrollingFrame", {
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 14, 0, 170),
	Size = UDim2.new(1, -28, 1, -182),
	ScrollingDirection = Enum.ScrollingDirection.Y,
	ScrollBarThickness = 6,
	ScrollBarImageColor3 = THEME.accent,
	CanvasSize = UDim2.new(0, 0, 0, 0),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	Parent = connectedPage,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = logScroll })
new("UIPadding", {
	PaddingLeft = UDim.new(0, 8),
	PaddingRight = UDim.new(0, 8),
	PaddingTop = UDim.new(0, 6),
	PaddingBottom = UDim.new(0, 6),
	Parent = logScroll,
})
new("UIListLayout", {
	Padding = UDim.new(0, 4),
	SortOrder = Enum.SortOrder.LayoutOrder,
	Parent = logScroll,
})

renderActivityLog = function()
	for _, child in ipairs(logScroll:GetChildren()) do
		if child:IsA("TextLabel") then
			child:Destroy()
		end
	end
	for i, line in ipairs(activityLog) do
		local lowered = line:lower()
		local isProblem = lowered:find("error") ~= nil or lowered:find("fail") ~= nil
		new("TextLabel", {
			Font = Enum.Font.Code,
			Text = line,
			TextSize = 12,
			TextColor3 = isProblem and THEME.danger or THEME.mutedText,
			TextWrapped = true,
			TextXAlignment = Enum.TextXAlignment.Left,
			BackgroundTransparency = 1,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
			LayoutOrder = i,
			Parent = logScroll,
		})
	end
end

-- ============================================================
-- VIEW STATE / SETTINGS HELPERS
-- ============================================================

setStatusLabel = function(text)
	statusLabel.Text = text
end

local function updateUserLabel()
	if type(robloxUsername) == "string" and robloxUsername ~= "" then
		userLabel.Text = "Signed in as " .. robloxUsername
	else
		userLabel.Text = "Connected"
	end
end

local function showPairingView()
	connectedPage.Visible = false
	pairingPage.Visible = true
	pairStatusLabel.Text = ""
	codeBox.Text = ""
end

local function showConnectedView()
	pairingPage.Visible = false
	connectedPage.Visible = true
	updateUserLabel()
	statusLabel.Text = "Connected - waiting for first sync..."
end

local function saveSession(newToken, newRobloxUsername)
	token = newToken
	robloxUsername = newRobloxUsername
	plugin:SetSetting("yield_token", token)
	plugin:SetSetting("yield_roblox_user", robloxUsername)
end

local function clearSession()
	token = nil
	robloxUsername = nil
	plugin:SetSetting("yield_token", nil)
	plugin:SetSetting("yield_roblox_user", nil)
end

-- ============================================================
-- WIRING
-- ============================================================

local function onWidgetEnabledChanged()
	toggleButton:SetActive(widget.Enabled)
	if widget.Enabled and token then
		startAutoSyncLoop(widget)
	else
		stopAutoSyncLoop()
	end
end

local function attemptLink(rawCode)
	local code = (rawCode or ""):gsub("%s", ""):upper()
	if #code == 0 then
		pairStatusLabel.Text = "Please enter your link code."
		pairStatusLabel.TextColor3 = THEME.danger
		return
	end

	connectButton.Text = "Linking..."
	pairStatusLabel.Text = "Linking to Yield..."
	pairStatusLabel.TextColor3 = THEME.mutedText

	-- Link is a one-time exchange of the code for a permanent, account-scoped token.
	-- No placeId/placeName here -- places are picked up automatically once linked.
	local ok, body = apiRequest("POST", "/link", {
		code = code,
	})

	connectButton.Text = "Connect"

	if not ok then
		pairStatusLabel.Text = "Could not link: " .. tostring(body) .. ". If Studio asked to allow HTTP requests, allow it and try again."
		pairStatusLabel.TextColor3 = THEME.danger
		return
	end

	if type(body) ~= "table" or not body.token then
		pairStatusLabel.Text = "Unexpected response from Yield. Check the code and try again."
		pairStatusLabel.TextColor3 = THEME.danger
		return
	end

	saveSession(body.token, body.robloxUsername)
	clearActivityLog()
	showConnectedView()
	if type(robloxUsername) == "string" and robloxUsername ~= "" then
		logActivity("Linked to Yield as " .. robloxUsername)
	else
		logActivity("Linked to Yield")
	end
	onWidgetEnabledChanged()
end

local function disconnect()
	apiRequest("POST", "/unlink", {}) -- best-effort; local state is cleared regardless
	stopAutoSyncLoop()
	clearSession()
	clearActivityLog()
	showPairingView()
end

connectButton.MouseButton1Click:Connect(function()
	attemptLink(codeBox.Text)
end)

codeBox.FocusLost:Connect(function(enterPressed)
	if enterPressed then
		attemptLink(codeBox.Text)
	end
end)

syncButton.MouseButton1Click:Connect(function()
	task.spawn(function()
		syncButton.Text = "Syncing..."
		local ok, err = pcall(performSync)
		if not ok then
			isSyncing = false
			logActivity("Sync error: " .. tostring(err))
		end
		syncButton.Text = "Sync now"
	end)
end)

pushButton.MouseButton1Click:Connect(function()
	task.spawn(function()
		pushButton.Text = "Pushing..."
		local ok, err = pcall(pushSnapshot)
		if not ok then
			logActivity("Push error: " .. tostring(err))
		end
		pushButton.Text = "Push code"
	end)
end)

disconnectButton.MouseButton1Click:Connect(disconnect)

toggleButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

widget:GetPropertyChangedSignal("Enabled"):Connect(onWidgetEnabledChanged)

-- ============================================================
-- BOOTSTRAP
-- ============================================================

local savedToken = plugin:GetSetting("yield_token")
local savedRobloxUser = plugin:GetSetting("yield_roblox_user")

if type(savedToken) == "string" and #savedToken > 0 then
	token = savedToken
	if type(savedRobloxUser) == "string" then
		robloxUsername = savedRobloxUser
	end
	showConnectedView()
else
	showPairingView()
end

renderActivityLog()
onWidgetEnabledChanged()
`;

export default ROBLOX_PLUGIN_SOURCE;
