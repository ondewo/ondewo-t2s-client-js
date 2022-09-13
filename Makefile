export

# ---------------- BEFORE RELEASE ----------------
# 1 - Update Version Number
# 2 - Update RELEASE.md
# 3 - make build
# -------------- Release Process Steps --------------
# 1 - Get Credentials from devops-accounts repo
# 2 - Create Release Branch and push
# 3 - Create Release Tag and push
# 4 - GitHub Release
# 5 - NPM Release

########################################################
# 		Variables
########################################################

ONDEWO_T2S_VERSION = 4.3.0

T2S_API_GIT_BRANCH=tags/4.3.0
ONDEWO_PROTO_COMPILER_GIT_BRANCH=tags/4.1.1
ONDEWO_PROTO_COMPILER_DIR=ondewo-proto-compiler
T2S_APIS_DIR=src/ondewo-t2s-api
T2S_PROTOS_DIR=${T2S_APIS_DIR}/ondewo
GOOGLE_APIS_DIR=${T2S_APIS_DIR}/googleapis
GOOGLE_PROTOS_DIR=${GOOGLE_APIS_DIR}/google
GITHUB_GH_TOKEN?=
NPM_AUTOMATION_TOKEN?=
IMAGE_UTILS_NAME=ondewo-t2s-client-utils-js:${ONDEWO_T2S_VERSION}
PRETTIER_WRITE?=

CURRENT_RELEASE_NOTES=`cat RELEASE.md \
	| sed -n '/Release ONDEWO T2S Js Client ${ONDEWO_T2S_VERSION}/,/\*\*/p'`


GH_REPO="https://github.com/ondewo/ondewo-t2s-client-js"
DEVOPS_ACCOUNT_GIT="ondewo-devops-accounts"
DEVOPS_ACCOUNT_DIR="./${DEVOPS_ACCOUNT_GIT}"
.DEFAULT_GOAL := help
########################################################
#       ONDEWO Standard Make Targets
########################################################

setup_developer_environment_locally: install_packages install_precommit_hooks ## Installs all needed packages and precommit hooks

install_packages: ## Install npm packages
	npm i

install_precommit_hooks: ## Install precommit hooks
	npx husky install

run_precommit_hooks:
	.husky/pre-commit

prettier: ## Checks formatting with Prettier - Use PRETTIER_WRITE=-w to also automatically apply corrections where needed
	node_modules/.bin/prettier --config .prettierrc --check --ignore-path .prettierignore $(PRETTIER_WRITE) ./

eslint: ## Checks Code Logic and Typing
	./node_modules/.bin/eslint .

TEST:	## Prints some important variables
	@echo "Release Notes: \n \n $(CURRENT_RELEASE_NOTES)"
	@echo "GH Token: \t $(GITHUB_GH_TOKEN)"

help: ## Print usage info about help targets
	# (first comment after target starting with double hashes ##)
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-40s\033[0m %s\n", $$1, $$2}'

makefile_chapters: ## Shows all sections of Makefile
	@echo `cat Makefile| grep "########################################################" -A 1 | grep -v "########################################################"`

check_build: #Checks if all built proto-code is there
	@rm -rf build_check.txt
	@for proto in `find src/ondewo-t2s-api/ondewo -iname "*.proto*"`; \
	do \
		cat $${proto} | grep import | grep "google/" | cut -d "\"" -f 2 | cut -d "." -f 1 >> build_check.txt; \
		echo $${proto} | cut -d "/" -f 3-5 | cut -d "." -f 1 >> build_check.txt; \
	done
	@echo "`sort build_check.txt | uniq`" > build_check.txt
	@for file in `cat build_check.txt`;\
	do \
		cat api/ondewo_t2s_api.js | grep -q $${file};\
		if test $$? != 0; then  echo "No Proto-Code for $${file} in api/ondewo_t2s_api.js" & exit 1;fi \
	done
	@rm -rf build_check.txt

########################################################
#       Repo Specific Make Targets
########################################################

########################################################
#		Release

release: ## Create Github and NPM Release
	@echo "Start Release"
	make install_precommit_hooks
	make build
	make check_build
	make run_precommit_hooks
	git status
	git add api
	git add Makefile
	git add src
	git add RELEASE.md
	git add package.json
	git add package-lock.json
	git add ${ONDEWO_PROTO_COMPILER_DIR}
	git status
	git commit -m "Preparing for Release ${ONDEWO_T2S_VERSION}"
	git push
	make publish_npm_via_docker
	make create_release_branch
	make create_release_tag
	make release_to_github_via_docker_image
	@echo "Finished Release"

gh_release: build_utils_docker_image release_to_github_via_docker_image ## Builds Utils Image and Releases to Github

npm_release: ## Releases to NPM
	@echo "Start NPM Release"
	npm publish ./npm --access public
	@echo "Finished NPM Release"

create_release_branch: ## Create Release Branch and push it to origin
	git checkout -b "release/${ONDEWO_T2S_VERSION}"
	git push -u origin "release/${ONDEWO_T2S_VERSION}"

create_release_tag: ## Create Release Tag and push it to origin
	git tag -a ${ONDEWO_T2S_VERSION} -m "release/${ONDEWO_T2S_VERSION}"
	git push origin ${ONDEWO_T2S_VERSION}

login_to_gh: ## Login to Github CLI with Access Token
	echo $(GITHUB_GH_TOKEN) | gh auth login -p ssh --with-token

build_gh_release: ## Generate Github Release with CLI
	gh release create --repo $(GH_REPO) "$(ONDEWO_T2S_VERSION)" -n "$(CURRENT_RELEASE_NOTES)" -t "Release ${ONDEWO_T2S_VERSION}"

########################################################
#		Docker

push_to_gh: login_to_gh build_gh_release ##Logs into Github CLI and Releases
	@echo 'Released to Github'

build_compiler: ## Builds Ondewo-Proto-Compiler
	cd ondewo-proto-compiler/js && sh build.sh

release_to_github_via_docker_image:  ## Release to Github via docker
	docker run --rm \
		-e GITHUB_GH_TOKEN=${GITHUB_GH_TOKEN} \
		${IMAGE_UTILS_NAME} make push_to_gh

build_utils_docker_image:  ## Build utils docker image
	docker build -f Dockerfile.utils -t ${IMAGE_UTILS_NAME} .

build_and_publish_npm_via_docker: build build_utils_docker_image ## Builds Code, Docker-Image and Releases to NPM
	docker run --rm \
		-e NPM_AUTOMATION_TOKEN=${NPM_AUTOMATION_TOKEN} \
		${IMAGE_UTILS_NAME} make docker_npm_release

docker_npm_release: ## Release to npm with docker image
	node --version
	npm --version
	@npm config set //registry.npmjs.org/:_authToken=${NPM_AUTOMATION_TOKEN}
	npm whoami
	make npm_release

########################################################
#		DEVOPS-ACCOUNTS

ondewo_release: spc clone_devops_accounts run_release_with_devops ## Release with credentials from devops-accounts repo
	@rm -rf ${DEVOPS_ACCOUNT_GIT}

clone_devops_accounts: ## Clones devops-accounts repo
	if [ -d $(DEVOPS_ACCOUNT_GIT) ]; then rm -Rf $(DEVOPS_ACCOUNT_GIT); fi
	git clone git@bitbucket.org:ondewo/${DEVOPS_ACCOUNT_GIT}.git

run_release_with_devops: ## Runs the make release target with credentials from devops-accounts
	$(eval info:= $(shell cat ${DEVOPS_ACCOUNT_DIR}/account_github.env | grep GITHUB_GH & cat ${DEVOPS_ACCOUNT_DIR}/account_npm.env | grep NPM_AUTOMATION_TOKEN ))
	make release $(info)

spc: ## Checks if the Release Branch, Tag and Pypi version already exist
	$(eval filtered_branches:= $(shell git branch --all | grep "release/${ONDEWO_T2S_VERSION}"))
	$(eval filtered_tags:= $(shell git tag --list | grep "${ONDEWO_T2S_VERSION}"))
	@if test "$(filtered_branches)" != ""; then echo "-- Test 1: Branch exists!!" & exit 1; else echo "-- Test 1: Branch is fine";fi
	@if test "$(filtered_tags)" != ""; then echo "-- Test 2: Tag exists!!" & exit 1; else echo "-- Test 2: Tag is fine";fi


########################################################
# Build

update_package: ## Updates Package Version in src/package.json
	@sed -i "s/\"version\": \"[0-9]*.[0-9]*.[0-9]\"/\"version\": \"${ONDEWO_T2S_VERSION}\"/g" src/package.json

build: check_out_correct_submodule_versions build_compiler update_package npm_run_build ## Build Code with Proto-Compiler
	@echo "################### PROMT FOR CHANGING FILE OWNERSHIP FROM ROOT TO YOU ##########################"
	@for f in `ls -la | grep root | cut -c 55-200`; \
	do \
		sudo chown -R `whoami`:`whoami` $$f && echo $$f; \
	done
	cp src/package.json .
	cp src/README.md .
	cp src/RELEASE.md .
	make remove_npm_script
	make create_npm_package
	make install_dependencies


remove_npm_script: ## Removes script section from package.json
	$(eval script_lines:= $(shell cat package.json | sed -n '/\"scripts\"/,/\}\,/='))
	$(eval start:= $(shell echo $(script_lines) | cut -c 1-2))
	$(eval end:= $(shell echo $(script_lines) | rev | cut -c 1-3 | rev))
	@sed -i '$(start),$(end)d' package.json

create_npm_package: ## Creates NPM Package for Release
	rm -rf npm
	mkdir npm
	cp -R api npm
	cp package.json npm
	cp LICENSE npm
	cp README.md npm

install_dependencies: ## Installs Dev-Dependencies
	npm i eslint --save-dev
	npm i prettier --save-dev
	npm i husky --save-dev
	npm i @typescript-eslint/eslint-plugin --save-dev

check_out_correct_submodule_versions: ## Fetches all Submodules and checksout specified branch
	@echo "START checking out correct submodule versions ..."
	git submodule update --init --recursive
	git -C ${T2S_APIS_DIR} fetch --all
	git -C ${T2S_APIS_DIR} checkout ${T2S_API_GIT_BRANCH}
	git -C ${ONDEWO_PROTO_COMPILER_DIR} fetch --all
	git -C ${ONDEWO_PROTO_COMPILER_DIR} checkout ${ONDEWO_PROTO_COMPILER_GIT_BRANCH}
	@echo "DONE checking out correct submodule versions."

npm_run_build: ## Runs the build command in package.json
	@echo "START npm run build ..."
	cd src/ && npm run build && cd ..
	@echo "DONE npm run build."

test-in-ondewo-aim: ## Runs test
	@echo "START copying files to local AIM for testing ..."
	cd src/ && npm run test-in-ondewo-aim && cd ..
	@echo "DONE copying files to local AIM for testing."

