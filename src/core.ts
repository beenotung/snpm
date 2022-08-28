import { execSync } from 'child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import semver from 'semver'

export function main(options: {
  storeDir: string
  cwd: string
  dev: boolean
  verbose: boolean
  installDeps: string[]
  installDevDeps: string[]
  uninstallDeps: string[]
}) {
  let storeDir = resolve(options.storeDir)
  mkdirSync(storeDir, { recursive: true })

  // package name -> exact versions
  let storePackageVersions = new Map<string, Set<string>>()

  for (let dirname of readdirSync(storeDir)) {
    if (dirname[0] !== '@') {
      let [name, version] = dirname.split('@')
      getVersions(storePackageVersions, name).add(version)
      continue
    }
    let orgName = dirname
    let orgDir = join(storeDir, dirname)
    for (let dirname of readdirSync(orgDir)) {
      let [name, version] = dirname.split('@')
      name = `${orgName}/${name}`
      getVersions(storePackageVersions, name).add(version)
    }
  }

  let packageFile = join(options.cwd, 'package.json')
  let packageJson = JSON.parse(
    readFileSync(packageFile).toString(),
  ) as PackageJSON
  let { dependencies, devDependencies } = packageJson

  let nodeModulesDir = join(options.cwd, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })

  let newDeps: Dependencies = {}
  let hasNewDeps = false
  let newInstallDeps: Dependencies = {}
  function addInstallDep(dep: string): { name: string; version: string } {
    let { name, version } = parseDep(dep)
    let storeVersions = getVersions(storePackageVersions, name)
    let exactVersion = semver.maxSatisfying(
      Array.from(storeVersions),
      version || '*',
    )
    if (exactVersion) {
      linkPackage(storeDir, nodeModulesDir, name, exactVersion)
      return { name, version: version || `^${exactVersion}` }
    }

    let npmVersions = npmViewVersions(dep)
    if (npmVersions.length === 0) throw new Error('No versions found: ' + dep)
    npmVersions.reverse()
    for (let exactVersion of npmVersions) {
      if (storeVersions.has(exactVersion)) {
        linkPackage(storeDir, nodeModulesDir, name, exactVersion)
        return { name, version: version || `^${exactVersion}` }
      }
    }
    exactVersion = npmVersions[0]
    version = version || `^${exactVersion}`
    newDeps[name] = version
    hasNewDeps = true
    return { name, version: version }
  }
  let hasUpdatedPackageJson = false
  if (options.installDeps.length > 0) {
    let deps = dependencies ? { ...dependencies } : {}
    for (let dep of options.installDeps) {
      let { name, version } = addInstallDep(dep)
      deps[name] = version
      newInstallDeps[name] = version
    }
    packageJson.dependencies = sortDeps(deps)
    hasUpdatedPackageJson = true
  }
  if (options.installDevDeps.length > 0) {
    let deps = devDependencies ? { ...devDependencies } : {}
    for (let dep of options.installDevDeps) {
      let { name, version } = addInstallDep(dep)
      deps[name] = version
      newInstallDeps[name] = version
    }
    packageJson.devDependencies = sortDeps(deps)
    hasUpdatedPackageJson = true
  }
  if (options.uninstallDeps.length > 0) {
    if (options.verbose) {
      console.log('uninstalling packages:', options.uninstallDeps)
    }
    for (let dep of options.uninstallDeps) {
      let { name } = parseDep(dep)
      uninstallDep(nodeModulesDir, name)
      if (packageJson.dependencies && name in packageJson.dependencies) {
        delete packageJson.dependencies[name]
        hasUpdatedPackageJson = true
        if (dependencies) {
          delete dependencies[name]
        }
      }
      if (packageJson.devDependencies && name in packageJson.devDependencies) {
        delete packageJson.devDependencies[name]
        hasUpdatedPackageJson = true
        if (devDependencies) {
          delete devDependencies[name]
        }
      }
    }
  }
  if (hasUpdatedPackageJson) {
    writeFileSync(packageFile, JSON.stringify(packageJson, null, 2))
  }

  function addPackageDep(name: string, versionRange: string) {
    let versions = Array.from(getVersions(storePackageVersions, name))
    let exactVersion = findLatestMatch(versionRange, versions)
    if (exactVersion) {
      linkPackage(storeDir, nodeModulesDir, name, exactVersion)
      return
    }
    newDeps[name] = versionRange
    hasNewDeps = true
  }
  if (devDependencies && options.dev) {
    for (let name in devDependencies) {
      let version = devDependencies[name]
      addPackageDep(name, version)
    }
  }
  if (dependencies) {
    for (let name in dependencies) {
      let version = dependencies[name]
      addPackageDep(name, version)
    }
  }

  let usedPackageVersions = new Map<string, Set<string>>()
  let collectedNodeModules = new Set<string>()
  function collectNodeModules(nodeModulesDir: string) {
    // detect cyclic dependencies
    let realNodeModulesDir = realpathSync(nodeModulesDir)
    if (collectedNodeModules.has(realNodeModulesDir)) {
      return
    }
    collectedNodeModules.add(realNodeModulesDir)
    for (let dirname of readdirSync(nodeModulesDir)) {
      if (dirname[0] === '.') continue
      if (dirname[0] !== '@') {
        let packageDir = join(nodeModulesDir, dirname)
        collectPackage(packageDir)
        continue
      }
      let orgName = dirname
      let orgDir = join(nodeModulesDir, orgName)
      for (let dirname of readdirSync(orgDir)) {
        let packageDir = join(orgDir, dirname)
        collectPackage(packageDir)
      }
    }
  }
  function collectPackage(packageDir: string) {
    let file = join(packageDir, 'package.json')
    let { name, version } = JSON.parse(
      readFileSync(file).toString(),
    ) as PackageJSON
    if (!name) throw new Error(`missing package name in ${file}`)
    if (!version) throw new Error(`missing package version in ${file}`)
    getVersions(storePackageVersions, name).add(version)
    getVersions(usedPackageVersions, name).add(version)
    let nodeModulesDir = join(packageDir, 'node_modules')
    if (existsSync(nodeModulesDir)) {
      collectNodeModules(nodeModulesDir)
    }
    let key = `${name}@${version}`
    let storePackageDir = join(storeDir, key)
    if (existsSync(storePackageDir)) {
      rmSync(packageDir, { recursive: true })
      return
    }
    if (name.includes('/')) {
      let parentDir = dirname(storePackageDir)
      mkdirSync(parentDir, { recursive: true })
    }
    mv(packageDir, storePackageDir)
  }

  if (hasNewDeps) {
    if (options.verbose) {
      console.log('installing new packages:', newDeps)
    }
    let tmpDir = join(nodeModulesDir, '.tmp')
    mkdirSync(tmpDir, { recursive: true })
    npmInstall(tmpDir, newDeps)
    let tmpNodeModulesDir = join(tmpDir, 'node_modules')
    collectNodeModules(tmpNodeModulesDir)
  }

  collectNodeModules(nodeModulesDir)

  if (options.verbose && usedPackageVersions.size > 0) {
    console.log('linking packages:', usedPackageVersions)
  }
  function linkDeps(packageDir: string) {
    let file = join(packageDir, 'package.json')
    let { dependencies } = JSON.parse(
      readFileSync(file).toString(),
    ) as PackageJSON
    if (!dependencies) return
    let nodeModulesDir = join(packageDir, 'node_modules')
    let hasDir = false
    for (let name in dependencies) {
      if (!hasDir) {
        mkdirSync(nodeModulesDir, { recursive: true })
        hasDir = true
      }
      let versionRange = dependencies[name]
      linkDep(nodeModulesDir, name, versionRange)
    }
  }
  function linkDep(nodeModulesDir: string, name: string, versionRange: string) {
    let versions = Array.from(getVersions(storePackageVersions, name))
    let exactVersion = findLatestMatch(versionRange, versions)
    if (!exactVersion)
      throw new Error(`missing package ${name} ${versionRange}`)
    let depPackageDir = linkPackage(
      storeDir,
      nodeModulesDir,
      name,
      exactVersion,
    )
    linkDeps(depPackageDir)
  }

  for (let name in newInstallDeps) {
    let version = newInstallDeps[name]
    linkDep(nodeModulesDir, name, version)
  }
  if (devDependencies && options.dev) {
    for (let name in devDependencies) {
      let version = devDependencies[name]
      linkDep(nodeModulesDir, name, version)
    }
  }
  if (dependencies) {
    for (let name in dependencies) {
      let version = dependencies[name]
      linkDep(nodeModulesDir, name, version)
    }
  }
}

function getVersions(map: Map<string, Set<string>>, name: string) {
  let set = map.get(name)
  if (!set) {
    set = new Set()
    map.set(name, set)
  }
  return set
}

type PackageJSON = {
  name?: string
  version?: string
  dependencies?: Dependencies
  devDependencies?: Dependencies
}

type Dependencies = {
  // package name -> version range
  [name: string]: string
}

function findLatestMatch(versionRange: string, exactVersions: string[]) {
  if (versionRange === 'latest') {
    versionRange = '*'
  }
  return semver.maxSatisfying(exactVersions, versionRange)
}

function makeSymbolicLink(src: string, dest: string) {
  try {
    symlinkSync(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return
    }
    throw err
  }
}

function linkPackage(
  storeDir: string,
  nodeModulesDir: string,
  packageName: string,
  exactVersion: string,
) {
  let src = join(storeDir, `${packageName}@${exactVersion}`)
  let dest = join(nodeModulesDir, packageName)
  if (packageName.includes('/')) {
    let parentDir = dirname(dest)
    mkdirSync(parentDir, { recursive: true })
  }
  makeSymbolicLink(src, dest)
  return src
}

function npmInstall(cwd: string, dependencies: Dependencies) {
  let cmd = 'npx npm i'
  let file = join(cwd, 'package.json')
  let json: PackageJSON = { dependencies }
  let text = JSON.stringify(json)
  writeFileSync(file, text)
  execSync(cmd, { cwd })
}

function mv(src: string, dest: string) {
  let cmd = `mv ${JSON.stringify(src)} ${JSON.stringify(dest)}`
  execSync(cmd)
}

function parseDep(dep: string): { name: string; version: string | null } {
  if (dep.length === 0) {
    throw new Error('Invalid dependency format (empty string)')
  }
  let parts = dep.split('@')
  switch (parts.length) {
    case 1:
      // e.g. semver
      return { name: parts[0], version: null }
    case 2:
      if (parts[0].length === 0) {
        // e.g. @types/semver
        return { name: '@' + parts[1], version: null }
      }
      // e.g. semver@^7.3.7
      return {
        name: parts[0],
        version: parts[1] || null,
      }
    case 3:
      if (parts[0].length > 0)
        throw new Error('Invalid dependency format: ' + JSON.stringify(dep))
      // e.g. @types/semver@^7.3.9
      return {
        name: '@' + parts[1],
        version: parts[2] || null,
      }
    default:
      throw new Error('Invalid dependency format: ' + JSON.stringify(dep))
  }
}

function npmViewVersions(dep: string): string[] {
  let cmd = `npm view ${JSON.stringify(dep)} version`
  let stdout = execSync(cmd)
  let versions: string[] = []
  stdout
    .toString()
    .split('\n')
    .forEach(line => {
      // e.g. `semver@1.0.8 '1.0.8'`
      let version = line.trim().split(' ').pop()
      if (!version) return
      versions.push(version.replace(/'/g, ''))
    })
  return versions
}

function uninstallDep(nodeModulesDir: string, name: string) {
  let dir = join(nodeModulesDir, name)
  console.debug('uninstall', { name, dir })
  rmSync(dir, { recursive: true, force: true })
}

function sortDeps(deps: Dependencies) {
  let newDeps: Dependencies = {}
  Object.keys(deps)
    .sort()
    .forEach(name => {
      let version = deps[name]
      newDeps[name] = version
    })
  return newDeps
}
